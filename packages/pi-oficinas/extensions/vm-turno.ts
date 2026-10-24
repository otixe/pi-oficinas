import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeSecret } from './secretaria-state.ts';

export interface VmTurnRequest {
  agente: string;
  task_id: string;
  minutos_max: number;
  encolada_at: string;
}
export interface VmTurnHolder extends VmTurnRequest {
  desde: string;
  hasta: string;
  vencimiento_avisado: boolean;
}
export interface VmTurnState {
  version: 1;
  secuencia: number;
  titular: VmTurnHolder | null;
  cola: VmTurnRequest[];
}
export interface VmTurnEvent {
  at: string;
  secuencia: number;
  accion: string;
  actor: string;
  task_id?: string;
  motivo?: string;
  estado: VmTurnState;
}
export interface VmTurnPaths { state: string; lock: string; history: string }

const LOCK_WAIT_MS = 10_000;
// F5 (a82e464f): bounded history. Past this size the history is archived to vm-turno.jsonl.1 and
// restarts with the last event (it carries the full state, so readState recovers the same).
let historyMaxBytes = 1024 * 1024;
export function __setVmTurnHistoryMaxBytesForTests(bytes: number): void { historyMaxBytes = bytes; }
const MAX_QUEUE = 500;
const MAX_DATE_MS = 8.64e15;
const validTask = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validAgent = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const validMinutes = (value: unknown, now: number) => Number.isSafeInteger(value) && (value as number) >= 1 &&
  Number.isFinite(now + (value as number) * 60_000) && Math.abs(now + (value as number) * 60_000) <= MAX_DATE_MS;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function vmTurnPaths(base: string): VmTurnPaths {
  const state = join(base, 'vm-turno.json');
  return { state, lock: `${state}.lock`, history: join(base, 'vm-turno.jsonl') };
}

function secureRegular(path: string, allowMissing = true): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077))
      throw new Error(`Archivo de turno inseguro: ${path}`);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT' && allowMissing) return false;
    throw error;
  }
}
function validRequest(value: any, team: string[]): value is VmTurnRequest {
  return !!value && validAgent(value.agente) && team.includes(value.agente) && validTask(value.task_id) &&
    typeof value.encolada_at === 'string' && Number.isFinite(Date.parse(value.encolada_at)) &&
    Number.isSafeInteger(value.minutos_max) && value.minutos_max >= 1 &&
    Number.isFinite(Date.parse(value.encolada_at) + value.minutos_max * 60_000) &&
    Math.abs(Date.parse(value.encolada_at) + value.minutos_max * 60_000) <= MAX_DATE_MS;
}
function validHolder(value: any, team: string[]): value is VmTurnHolder {
  return validRequest(value, team) && typeof value.desde === 'string' && Number.isFinite(Date.parse(value.desde)) &&
    typeof value.hasta === 'string' && Number.isFinite(Date.parse(value.hasta)) && Date.parse(value.hasta) > Date.parse(value.desde) &&
    typeof value.vencimiento_avisado === 'boolean';
}
function validateState(value: any, team: string[]): VmTurnState {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.secuencia) || value.secuencia < 0 ||
      (value.titular !== null && !validHolder(value.titular, team)) ||
      !Array.isArray(value.cola) || value.cola.length > MAX_QUEUE ||
      value.cola.some((request: unknown) => !validRequest(request, team)) ||
      new Set(value.cola.map((request: VmTurnRequest) => request.agente)).size !== value.cola.length ||
      (!value.titular && value.cola.length > 0) ||
      (value.titular && value.cola.some((row: VmTurnRequest) => row.agente === value.titular!.agente)))
    throw new Error('Estado vm-turno.json inválido; fallo cerrado');
  return value as VmTurnState;
}
function emptyState(): VmTurnState { return { version: 1, secuencia: 0, titular: null, cola: [] }; }
function parseHistoryText(text: string, team: string[]): VmTurnEvent[] {
  if (text && !text.endsWith('\n')) throw new Error('Historial vm-turno.jsonl incompleto; fallo cerrado');
  const rows = text.split('\n').filter(Boolean).map((line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { throw new Error('Historial vm-turno.jsonl corrupto; fallo cerrado'); }
    if (!event || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        !Number.isSafeInteger(event.secuencia) || event.secuencia < 1 || typeof event.accion !== 'string' ||
        typeof event.actor !== 'string' || !event.estado || (event.motivo !== undefined && typeof event.motivo !== 'string'))
      throw new Error('Evento vm-turno.jsonl inválido; fallo cerrado');
    event.estado = validateState(event.estado, team);
    if (event.estado.secuencia !== event.secuencia) throw new Error('Secuencia incoherente en vm-turno.jsonl; fallo cerrado');
    return event as VmTurnEvent;
  });
  for (let i = 1; i < rows.length; i++) if (rows[i].secuencia !== rows[i - 1].secuencia + 1)
    throw new Error('Secuencia truncada o repetida en vm-turno.jsonl; fallo cerrado');
  return rows;
}
function archiveLastSequence(path: string, team: string[]): number | null {
  if (!secureRegular(`${path}.1`)) return null;
  const archived = parseHistoryText(readFileSync(`${path}.1`, 'utf8'), team);
  return archived.length ? archived.at(-1)!.secuencia : null;
}
function readHistory(path: string, team: string[]): VmTurnEvent[] {
  // Crash between the two renames of a rotation: the history is missing but the archive is not.
  if (!secureRegular(path)) return secureRegular(`${path}.1`) ? parseHistoryText(readFileSync(`${path}.1`, 'utf8'), team) : [];
  const rows = parseHistoryText(readFileSync(path, 'utf8'), team);
  // F5: after a rotation the history starts with the last archived event. A head truncated
  // WITHOUT a matching archive is still fail-closed.
  const archived = rows.length && rows[0].secuencia !== 1 ? archiveLastSequence(path, team) : null;
  // archive ends at N: the history starts at N (normal rotation) or N+1 (crash between the renames).
  if (rows.length && rows[0].secuencia !== 1 && (archived === null || (archived !== rows[0].secuencia && archived !== rows[0].secuencia - 1)))
    throw new Error('El historial vm-turno.jsonl no comienza en secuencia 1 ni continúa su archivo; fallo cerrado');
  return rows;
}
function readState(paths: VmTurnPaths, team: string[]): VmTurnState {
  secureRegular(paths.state);
  let state = existsSync(paths.state) ? validateState(JSON.parse(readFileSync(paths.state, 'utf8')), team) : emptyState();
  const history = readHistory(paths.history, team);
  if (history.length) {
    const last = history.at(-1)!;
    if (last.secuencia < state.secuencia) throw new Error('El historial no alcanza el estado guardado; fallo cerrado');
    if (last.secuencia > state.secuencia) state = clone(last.estado); // recover state after a crash between journal and snapshot.
  } else if (state.secuencia !== 0) throw new Error('Falta vm-turno.jsonl para un estado ya modificado; fallo cerrado');
  return state;
}
function syncDirectory(path: string) {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); }
}
function persist(paths: VmTurnPaths, state: VmTurnState) {
  secureRegular(paths.state);
  const temp = `${paths.state}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, paths.state);
    syncDirectory(join(paths.state, '..'));
  } finally {
    if (fd !== undefined) closeSync(fd);
    // An abandoned temp snapshot is not the history and must not be silently erased.
  }
}
function commit(paths: VmTurnPaths, oldState: VmTurnState, newState: VmTurnState, accion: string, actor: string,
  taskId?: string, motivo?: string) {
  newState.secuencia = oldState.secuencia + 1;
  const event: VmTurnEvent = { at: new Date().toISOString(), secuencia: newState.secuencia, accion, actor,
    ...(taskId ? { task_id: taskId } : {}), ...(motivo ? { motivo } : {}), estado: clone(newState) };
  secureRegular(paths.history);
  let fd: number | undefined;
  try {
    fd = openSync(paths.history, 'a', 0o600);
    writeFileSync(fd, JSON.stringify(event) + '\n', 'utf8');
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
  persist(paths, newState);
  rotateHistoryIfLarge(paths, event);
}
function rotateHistoryIfLarge(paths: VmTurnPaths, last: VmTurnEvent) {
  if (lstatSync(paths.history).size <= historyMaxBytes) return;
  const temp = `${paths.history}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(last) + '\n', 'utf8');
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
  renameSync(paths.history, `${paths.history}.1`); // the previous archive generation is overwritten
  renameSync(temp, paths.history);
  syncDirectory(join(paths.history, '..'));
}
async function withLock<T>(base: string, fn: (paths: VmTurnPaths) => T | Promise<T>): Promise<T> {
  const paths = vmTurnPaths(base);
  let fd: number | undefined;
  const started = Date.now();
  while (fd === undefined) {
    try { fd = openSync(paths.lock, 'wx', 0o600); }
    catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      secureRegular(paths.lock, false);
      if (Date.now() - started >= LOCK_WAIT_MS)
        throw new Error('Lock vm-turno ocupado o huérfano; no se modificó el turno');
      await wait(20);
    }
  }
  const opened = fstatSync(fd);
  try { return await fn(paths); }
  finally {
    closeSync(fd);
    const current = lstatSync(paths.lock);
    if (current.dev === opened.dev && current.ino === opened.ino) unlinkSync(paths.lock);
  }
}
function assertTeamMember(team: string[], agent: string) {
  if (!validAgent(agent) || !team.includes(agent)) throw new Error(`Identidad fuera del equipo para turno VM: ${agent}`);
}
function newHolder(request: VmTurnRequest, now: number): VmTurnHolder {
  const desde = new Date(now).toISOString();
  return { ...request, desde, hasta: new Date(now + request.minutos_max * 60_000).toISOString(), vencimiento_avisado: false };
}
function reasonText(reason: string | undefined, fallback: string): string {
  const value = reason?.trim() || fallback;
  if (value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('motivo inválido (máximo 500 caracteres, sin controles)');
  // F5: the motivo stays in vm-turno.jsonl; nothing that looks like a credential is persisted.
  if (looksLikeSecret(value)) throw new Error('motivo inválido: parece una credencial; no se guarda');
  return value;
}

export interface VmTurnOutcome {
  estado: VmTurnState;
  resultado: string;
  notificar?: { agente: string; task_id: string };
  removido?: { agente: string; task_id: string };
  desalojado?: { agente: string; task_id: string; nuevo_task_id: string };
}
export interface VmTurnTestOptions { afterStateRead?: () => Promise<void> }

export async function pedirVmTurno(base: string, team: string[], agente: string, taskId: string, minutosMax: number,
  now = Date.now(), testOptions: VmTurnTestOptions = {}): Promise<VmTurnOutcome> {
  assertTeamMember(team, agente);
  if (!validTask(taskId) || !validMinutes(minutosMax, now))
    throw new Error('Parámetros inválidos: minutos_max debe ser entero positivo y su fecha límite válida');
  return withLock(base, async paths => {
    const state = readState(paths, team);
    await testOptions.afterStateRead?.(); // deterministic race window for the lock mutation test.
    if (state.titular?.agente === agente) {
      if (state.titular.task_id === taskId) return { estado: state, resultado: 'ya_titular' };
      throw new Error('Ya sos titular con otra tarea; liberá el slot antes de pedir otro');
    }
    const queued = state.cola.find(item => item.agente === agente);
    if (queued) {
      if (queued.task_id === taskId) return { estado: state, resultado: 'ya_en_cola' };
      throw new Error(`Ya estás en cola con ${queued.task_id}; no se agregó otra solicitud`);
    }
    const request: VmTurnRequest = { agente, task_id: taskId, minutos_max: minutosMax, encolada_at: new Date(now).toISOString() };
    const next = clone(state);
    if (!next.titular) {
      next.titular = newHolder(request, now);
      commit(paths, state, next, 'pedir_con_turno_libre', agente, taskId);
      return { estado: next, resultado: 'concedido' };
    }
    if (next.cola.length >= MAX_QUEUE) throw new Error('Cola VM llena; no se agregó la solicitud');
    next.cola.push(request);
    commit(paths, state, next, 'pedir_a_cola', agente, taskId);
    return { estado: next, resultado: 'encolado' };
  });
}

export async function liberarVmTurno(base: string, team: string[], agente: string, taskId: string, now = Date.now()): Promise<VmTurnOutcome> {
  assertTeamMember(team, agente);
  if (!validTask(taskId)) throw new Error('task_id inválido');
  return withLock(base, paths => {
    const state = readState(paths, team);
    if (!state.titular || state.titular.agente !== agente || state.titular.task_id !== taskId)
      throw new Error('Sólo el titular puede liberar su turno y debe indicar su task_id actual');
    const next = clone(state);
    next.titular = null;
    let notificar: VmTurnOutcome['notificar'];
    while (next.cola.length && !next.titular) {
      const request = next.cola.shift()!;
      next.titular = newHolder(request, now);
      notificar = { agente: request.agente, task_id: request.task_id };
    }
    commit(paths, state, next, next.titular ? 'liberar_y_entregar_siguiente' : 'liberar_sin_cola', agente, taskId,
      'Liberación voluntaria por titular');
    return { estado: next, resultado: next.titular ? `liberado; turno concedido a ${next.titular.agente}` : 'liberado; cola vacía',
      ...(notificar ? { notificar } : {}) };
  });
}

export async function estadoVmTurno(base: string, team: string[]): Promise<VmTurnState> {
  return withLock(base, paths => readState(paths, team));
}

/** Leader-only at the tool boundary. A prior holder is moved to the FIFO head, never terminated. */
export async function asignarVmTurno(base: string, team: string[], actor: string, agente: string, taskId: string,
  minutosMax: number, motivo?: string, now = Date.now()): Promise<VmTurnOutcome> {
  assertTeamMember(team, actor); assertTeamMember(team, agente);
  if (!validTask(taskId) || !validMinutes(minutosMax, now)) throw new Error('task_id o minutos_max inválido');
  const reason = reasonText(motivo, `Reasignación de la líder a ${taskId}`);
  return withLock(base, paths => {
    const state = readState(paths, team);
    if (state.titular?.agente === agente) {
      if (state.titular.task_id === taskId) {
        const next = clone(state);
        commit(paths, state, next, 'asignar_turno_sin_cambio', actor, taskId, reason);
        return { estado: next, resultado: 'ese agente ya tiene el turno para esa tarea' };
      }
      throw new Error('El agente indicado ya es titular con otra tarea; no se reemplaza su slot consigo mismo');
    }
    const next = clone(state);
    const queuedIndex = next.cola.findIndex(row => row.agente === agente);
    if (queuedIndex >= 0) next.cola.splice(queuedIndex, 1);
    let desalojado: VmTurnOutcome['desalojado'];
    if (next.titular) {
      if (next.cola.length >= MAX_QUEUE) throw new Error('Cola VM llena; no se asignó el turno');
      const prior = next.titular;
      next.cola.unshift({ agente: prior.agente, task_id: prior.task_id, minutos_max: prior.minutos_max, encolada_at: new Date(now).toISOString() });
      desalojado = { agente: prior.agente, task_id: prior.task_id, nuevo_task_id: taskId };
    }
    const request: VmTurnRequest = { agente, task_id: taskId, minutos_max: minutosMax, encolada_at: new Date(now).toISOString() };
    next.titular = newHolder(request, now);
    commit(paths, state, next, 'asignar_turno_lider', actor, taskId, reason);
    return { estado: next, resultado: `${agente} tiene el turno para ${taskId}${desalojado ? `; ${desalojado.agente} pasó al frente de la cola` : ''}`,
      notificar: { agente, task_id: taskId }, ...(desalojado ? { desalojado } : {}) };
  });
}

/** Leader-only at the tool boundary. Removes an office from the holder slot or queue. */
export async function quitarVmTurno(base: string, team: string[], actor: string, agente: string, motivo?: string,
  now = Date.now()): Promise<VmTurnOutcome> {
  assertTeamMember(team, actor); assertTeamMember(team, agente);
  const reason = reasonText(motivo, `Retiro de ${agente} por la líder`);
  return withLock(base, paths => {
    const state = readState(paths, team);
    const next = clone(state);
    let removido: VmTurnOutcome['removido'];
    let notificar: VmTurnOutcome['notificar'];
    let slotLiberado = false;
    if (next.titular?.agente === agente) {
      const prior = next.titular;
      removido = { agente, task_id: prior.task_id };
      next.titular = null;
      slotLiberado = true;
      if (next.cola.length) {
        const request = next.cola.shift()!;
        next.titular = newHolder(request, now);
        notificar = { agente: request.agente, task_id: request.task_id };
      }
    } else {
      const index = next.cola.findIndex(row => row.agente === agente);
      if (index < 0) {
        const unchanged = clone(state);
        commit(paths, state, unchanged, 'quitar_sin_cambio', actor, undefined, reason);
        return { estado: unchanged, resultado: `${agente} no tenía turno ni solicitud en cola` };
      }
      const [request] = next.cola.splice(index, 1);
      removido = { agente, task_id: request.task_id };
    }
    const accion = slotLiberado ? (next.titular ? 'quitar_agente_y_entregar_siguiente' : 'quitar_agente_sin_siguiente') : 'quitar_agente_de_cola';
    commit(paths, state, next, accion, actor, removido?.task_id, reason);
    return { estado: next, resultado: `${agente} quitado${notificar ? `; turno entregado a ${notificar.agente}` : ''}`,
      ...(removido ? { removido } : {}), ...(notificar ? { notificar } : {}) };
  });
}

/** Marks an expired turn for a leader notification; the holder is intentionally NOT released. */
export async function marcarVencimientoVmTurno(base: string, team: string[], now = Date.now()): Promise<VmTurnOutcome> {
  return withLock(base, paths => {
    const state = readState(paths, team);
    const holder = state.titular;
    if (!holder || Date.parse(holder.hasta) > now || holder.vencimiento_avisado)
      return { estado: state, resultado: holder && Date.parse(holder.hasta) <= now ? 'ya_avisado' : 'vigente' };
    const next = clone(state);
    next.titular!.vencimiento_avisado = true;
    commit(paths, state, next, 'vencido_avisar_lider_sin_liberar', 'secretaria', holder.task_id,
      'Turno vencido; retener el slot por posible CID en vuelo');
    return { estado: next, resultado: 'vencido_no_liberado', notificar: { agente: holder.agente, task_id: holder.task_id } };
  });
}
