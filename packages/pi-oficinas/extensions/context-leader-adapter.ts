import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContextSnapshot } from './context70.ts';
import type { ContextNotice, RelaunchDependencies, RelaunchRecord, RelaunchRegistry, RelaunchTask, RelaunchObserverStatus } from './context-relaunch.ts';

const exec = promisify(execFile);
const ID = /^[a-z][a-z0-9-]{0,39}$/;
export interface ContextLeaderTeam { lider: string; oficinas: string[]; base: string; lider_body: string }
/** Construct only after checking caller's authenticated leader identity in the integration layer. */
export interface ContextLeaderAdapterContext {
  team: ContextLeaderTeam;
  leaderPaneId: string;
  /** Inject a private HOME for isolated tests; defaults to the process user's HOME. */
  home?: string;
  /** Explicit team's equipo.json; absent means <team.base>/equipo.json (never package fallback). */
  teamFile?: string;
}
export interface ContextLeaderCallbacks {
  /** Authenticated Cerebro task fetch; errors must propagate, never return a guessed task. */
  getTask(taskId: string): Promise<(RelaunchTask & {tags?: string[]}) | null>;
  ringTask(office: string, taskId: string): Promise<void>;
  /** Injectable read-only equivalent of `herdr pane get <id>`; no mutation. */
  paneGet?: (paneId: string) => Promise<unknown>;
  /** Tests inject this to avoid real CLI. Production defaults to the packaged CLI. */
  runRelaunch?: (office: string) => Promise<boolean>;
}
const own = (path: string, kind: 'file'|'dir') => {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== process.getuid?.() ||
      (kind === 'dir' ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) throw new Error('Owner/type/symlink inseguro');
  return st;
};
function chain(path: string) {
  let part = resolve(path);
  while (true) {
    const st = lstatSync(part);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== process.getuid?.() && st.uid !== 0)) throw new Error('Ancestro inseguro');
    if (part === resolve(part, '..')) break;
    part = resolve(part, '..');
  }
}
function safeDir(path: string) { if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Ruta no canónica'); chain(path); own(path, 'dir'); }
function safeFile(path: string, max: number): string {
  own(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > max) throw new Error('Archivo inseguro/grande');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function sessionBucket(home: string, body: string) {
  return join(home, '.pi', 'agent', 'sessions', '--' + body.slice(1).replaceAll('/', '-') + '--');
}
function safeSession(home: string, body: string, session: string) {
  if (typeof session !== 'string' || !isAbsolute(session) || resolve(session) !== session ||
      !session.startsWith(sessionBucket(home, body) + '/') || resolve(session, '..') !== sessionBucket(home, body)) return false;
  try { safeDir(sessionBucket(home, body)); own(session, 'file'); return true; } catch { return false; }
}
function pane(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as any;
  const info = value?.result?.pane ?? value;
  return info && typeof info === 'object' && !Array.isArray(info) ? info : null;
}
const status = (p: Record<string, any>): RelaunchObserverStatus => {
  const state = p.agent_status;
  const value = typeof state === 'object' && state !== null ? state.status : state;
  return value === 'idle' || value === 'done' || value === 'working' ? value : 'unknown';
};
function checkOffice(p: Record<string, any> | null, r: RelaunchRecord, body: string, home: string): boolean {
  const session = p?.agent_session;
  return !!p && p.pane_id === r.pane_id && p.tab_id === r.parent_tab_id && p.terminal_id === r.terminal_id &&
    p.cwd === body && p.foreground_cwd === body && p.agent === 'pi' && session?.agent === 'pi' &&
    session?.kind === 'path' && session?.value === r.session && safeSession(home, body, r.session);
}
const childEnv = (home: string, leaderPaneId: string) => ({
  PATH: `${join(home,'.local/bin')}:${join(home,'.npm-global/bin')}:/usr/local/bin:/usr/bin:/bin`,
  HOME: home, HERDR_PANE_ID: leaderPaneId,
});
export function contextLeaderTeamFile(ctx: ContextLeaderAdapterContext): string {
  return ctx.teamFile ?? join(ctx.team.base, 'equipo.json');
}
/** Fail closed. Never print CLI/Herdr stdout or stderr, which may contain session paths. */
export function buildContextRelaunchDeps(ctx: ContextLeaderAdapterContext, pendingMap: Map<string, ContextNotice>, callbacks: ContextLeaderCallbacks): RelaunchDependencies {
  const {team, leaderPaneId} = ctx;
  const home = ctx.home ?? homedir();
  const teamFile = contextLeaderTeamFile(ctx);
  if (!team || !ID.test(team.lider) || !Array.isArray(team.oficinas) || !team.oficinas.length ||
      !team.oficinas.every(o => typeof o === 'string' && ID.test(o)) || new Set(team.oficinas).size !== team.oficinas.length ||
      typeof leaderPaneId !== 'string' || !leaderPaneId || !isAbsolute(home) || !isAbsolute(team.base) ||
      !isAbsolute(team.lider_body) || !isAbsolute(teamFile) || !team.oficinas.every(o => o !== team.lider) || !(pendingMap instanceof Map) ||
      typeof callbacks?.getTask !== 'function' || typeof callbacks?.ringTask !== 'function') throw new Error('Config adapter inválida');
  const officeBody = (office: string) => join(team.base, office);
  const readRegistry = async (): Promise<RelaunchRegistry | null> => {
    try {
      safeDir(team.base);
      const data = JSON.parse(safeFile(join(team.base, 'registro.json'), 1024 * 1024));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data;
    } catch { return null; }
  };
  const paneGet = callbacks.paneGet ?? (async (id: string): Promise<unknown> => {
    const {stdout} = await exec('herdr', ['pane', 'get', id], {env: childEnv(home, leaderPaneId), timeout: 10_000, maxBuffer: 256 * 1024});
    return JSON.parse(stdout);
  });
  const officeRecord = async (office: string): Promise<RelaunchRecord | null> => {
    if (!team.oficinas.includes(office)) return null;
    const registry = await readRegistry();
    const r = registry?.[office] as any;
    const body = officeBody(office);
    try {
      safeDir(body);
      if (r?.body !== body || typeof r.pane_id !== 'string' || !r.pane_id || typeof r.parent_tab_id !== 'string' ||
          !r.parent_tab_id || typeof r.terminal_id !== 'string' || !r.terminal_id || !safeSession(home, body, r.session)) return null;
      return r as RelaunchRecord;
    } catch { return null; }
  };
  return {
    pending: pendingMap, offices: [...team.oficinas], leader: team.lider, leaderPaneId,
    getRegistry: readRegistry,
    async getSnapshot(office) {
      const r = await officeRecord(office);
      if (!r) return null;
      const body = officeBody(office);
      const snapshot = readContextSnapshot(body, r.session);
      return snapshot && snapshot.sessionFile === r.session ? {percent: snapshot.percent, sessionFile: snapshot.sessionFile} : null;
    },
    async getTask(taskId) {
      const task = await callbacks.getTask(taskId);
      return task && Array.isArray(task.tags) && task.tags.includes('oficina') ? task : null;
    },
    async ownsLeaderPane(id) {
      try {
        if (id !== leaderPaneId) return false;
        safeDir(team.lider_body);
        const p = pane(await paneGet(id));
        return !!p && p.pane_id === id && p.cwd === team.lider_body && p.foreground_cwd === team.lider_body &&
          p.agent === 'pi' && p.agent_session?.agent === 'pi' && p.agent_session?.kind === 'path';
      } catch { return false; }
    },
    async verifyPane(office, record) {
      try {
        const r = await officeRecord(office);
        return !!r && r.pane_id === record.pane_id && r.parent_tab_id === record.parent_tab_id &&
          r.terminal_id === record.terminal_id && r.session === record.session &&
          checkOffice(pane(await paneGet(record.pane_id)), record, officeBody(office), home);
      } catch { return false; }
    },
    async getObserverStatus(office) {
      try {
        const r = await officeRecord(office);
        if (!r) return 'unknown';
        const p = pane(await paneGet(r.pane_id));
        return checkOffice(p, r, officeBody(office), home) ? status(p!) : 'unknown';
      } catch { return 'unknown'; }
    },
    async verifyGate(office, record) {
      try {
        const r = await officeRecord(office);
        if (!r || r.session !== record.session || r.pane_id !== record.pane_id || !safeSession(home, officeBody(office), record.session)) return false;
        const state = join(officeBody(office), 'state'); safeDir(state);
        return safeFile(join(state, 'secretaria-gate-ok'), 256) === `${record.pane_id}\n`;
      } catch { return false; }
    },
    runRelaunch: callbacks.runRelaunch ?? (async office => {
      if (!team.oficinas.includes(office) || !await officeRecord(office)) return false;
      try {
        chain(resolve(teamFile, '..'));
        const config = JSON.parse(safeFile(teamFile, 1024 * 1024));
        if (config.base !== team.base || config.lider !== team.lider || config.lider_body !== team.lider_body ||
            JSON.stringify(config.oficinas) !== JSON.stringify(team.oficinas)) return false;
        const cli = fileURLToPath(new URL('../bin/oficina', import.meta.url));
        await exec('python3', [cli, '--equipo', teamFile, 'relanzar', office], {
          cwd: team.lider_body, env: childEnv(home, leaderPaneId), timeout: 300_000, maxBuffer: 4096,
        });
        return true;
      } catch { return false; }
    }),
    ringTask: callbacks.ringTask,
  };
}
