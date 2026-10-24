import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** A small, session-bound signal, not a task queue. Never infer usage from a TUI pane. */
export const CONTEXT_THRESHOLD = 70;
export const CONTEXT_SNAPSHOT_FILE = '.oficina-context70.json';
export const CONTEXT_SNAPSHOT_TTL_MS = 5 * 60_000;
export interface ContextSnapshot {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  sessionId: string | null;
  sessionFile: string | null;
  observedAt: number;
}

export function contextSnapshot(ctx: Pick<ExtensionContext, 'getContextUsage' | 'sessionManager'>, now = Date.now()): ContextSnapshot {
  let usage: ReturnType<ExtensionContext['getContextUsage']> | undefined;
  let sessionId: unknown, sessionFile: unknown;
  try { usage = ctx.getContextUsage(); } catch { /* unknown is not below threshold */ }
  try { sessionId = ctx.sessionManager.getHeader()?.id; sessionFile = ctx.sessionManager.getSessionFile(); }
  catch { /* cannot authorize a snapshot without both session anchors */ }
  const percent = usage?.percent;
  return {
    tokens: typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null,
    contextWindow: typeof usage?.contextWindow === 'number' && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null,
    percent: typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
    sessionId: typeof sessionId === 'string' && sessionId.length ? sessionId : null,
    sessionFile: typeof sessionFile === 'string' && isAbsolute(sessionFile) ? sessionFile : null,
    observedAt: now,
  };
}

/** Only the already-working task may continue. Unknown usage is conservatively deferred. */
export function shouldDeferNewTask(snapshot: Pick<ContextSnapshot, 'percent'> | null, taskStatus: string): boolean {
  if (taskStatus === 'working' || taskStatus === 'in_progress') return false;
  return snapshot?.percent == null || !Number.isFinite(snapshot.percent) || snapshot.percent < 0 || snapshot.percent > 100 || snapshot.percent >= CONTEXT_THRESHOLD;
}

function validSnapshot(s: unknown): s is ContextSnapshot {
  if (!s || typeof s !== 'object') return false;
  const x = s as ContextSnapshot;
  return (x.percent === null || (typeof x.percent === 'number' && Number.isFinite(x.percent) && x.percent >= 0 && x.percent <= 100)) &&
    (x.tokens === null || (typeof x.tokens === 'number' && Number.isFinite(x.tokens) && x.tokens >= 0)) &&
    (x.contextWindow === null || (typeof x.contextWindow === 'number' && Number.isFinite(x.contextWindow) && x.contextWindow > 0)) &&
    typeof x.sessionId === 'string' && !!x.sessionId && typeof x.sessionFile === 'string' && isAbsolute(x.sessionFile) &&
    typeof x.observedAt === 'number' && Number.isFinite(x.observedAt);
}
function paths(cwd: string) {
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory() || lstatSync(cwd).isSymbolicLink()) throw new Error('Directorio de snapshot inseguro');
  return { target: join(cwd, CONTEXT_SNAPSHOT_FILE), trash: join(cwd, '.trash') };
}
function assertRegular(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Snapshot no es archivo regular exclusivo');
  return st;
}
function trashDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Directorio .trash inseguro');
}
/** Retain old generations in .trash; publish by atomic rename. Never follow an existing symlink. */
export function writeContextSnapshot(cwd: string, snapshot: ContextSnapshot, sessionFile: string): void {
  if (!validSnapshot(snapshot) || snapshot.sessionFile !== sessionFile) throw new Error('Sesión de snapshot inválida');
  const { target, trash } = paths(cwd);
  trashDirectory(trash); // Before creating any temporary file, make cleanup possible.
  const temp = join(cwd, `${CONTEXT_SNAPSHOT_FILE}.${randomUUID()}.tmp`);
  let fd: number | undefined, published = false;
  try {
    // Reject an existing symlink rather than silently replacing it.
    try { assertRegular(target); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, JSON.stringify(snapshot) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try {
      assertRegular(target);
      linkSync(target, join(trash, `context70-old-${randomUUID()}.json`)); // hard link retains the old bytes before replace
    } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    renameSync(temp, target);
    published = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try { renameSync(temp, join(trash, `context70-failed-${randomUUID()}.tmp`)); }
      catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    }
  }
}

export const persistContextSnapshot = writeContextSnapshot;

/** Leader sweep: match the current registered session file AND optional session id; reject future data.
 * A high-context signal remains valid until the session changes, including after >5min idle.
 * An optional maxAgeMs is only for consumers requiring freshness independently. */
export function readContextSnapshot(cwd: string, sessionFile: string, now = Date.now(), sessionId?: string, maxAgeMs = Infinity): ContextSnapshot | null {
  if (!isAbsolute(sessionFile) || !Number.isFinite(now)) return null;
  try {
    const { target } = paths(cwd);
    const before = assertRegular(target);
    if (before.size > 1024) return null;
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > 1024) return null;
      raw = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    const snapshot: unknown = JSON.parse(raw);
    if (!validSnapshot(snapshot) || snapshot.sessionFile !== sessionFile || (sessionId !== undefined && snapshot.sessionId !== sessionId) ||
        snapshot.observedAt > now || (Number.isFinite(maxAgeMs) && now - snapshot.observedAt > maxAgeMs)) return null;
    return snapshot;
  } catch { return null; }
}
