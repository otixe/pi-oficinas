/** Leader-side context70 coordinator. All observations/effects are supplied by the caller;
 * this module never starts processes, reads a live registry or sends a bell itself. */
export interface RelaunchRecord {
  pane_id: string;
  parent_tab_id: string;
  terminal_id: string;
  session: string; // Pi session file path sealed by bin/oficina
}
export interface RelaunchRegistry {
  _creators?: Record<string, string>;
  [office: string]: unknown;
}
export interface RelaunchSnapshot {
  percent: number | null;
  sessionFile: string | null;
}
export interface RelaunchTask { id: string; status: string; assignee: string }
export type RelaunchObserverStatus = 'idle' | 'done' | 'working' | 'unknown' | 'missing';
export interface ContextNotice { office: string; percent: number | null; taskId: string }
/** Null is an explicit post-compaction unknown, never fabricated as a percentage. */
export function formatContextNotice(n: ContextNotice): string {
  return n.percent === null
    ? `${n.office}: uso de contexto desconocido: relanzar antes de ${n.taskId}`
    : `${n.office} al ${n.percent}% de contexto: relanzar antes de ${n.taskId}`;
}

/** Exact, bounded grammar; never interpolate untrusted notice fields into a command. */
export function parseContextNotice(text: unknown, offices: readonly string[]): ContextNotice | null {
  if (typeof text !== 'string' || text.length > 180 || !Array.isArray(offices)) return null;
  const unknown = /^([a-z][a-z0-9-]{0,39}): uso de contexto desconocido: relanzar antes de ([A-Za-z0-9:_-]{1,64})$/.exec(text);
  if (unknown) return offices.includes(unknown[1]) ? {office:unknown[1],percent:null,taskId:unknown[2]} : null;
  const match = /^([a-z][a-z0-9-]{0,39}) al (0|[1-9][0-9]{0,2})% de contexto: relanzar antes de ([A-Za-z0-9:_-]{1,64})$/.exec(text);
  if (!match || !offices.includes(match[1])) return null;
  const percent = Number(match[2]);
  return percent <= 100 ? {office: match[1], percent, taskId: match[3]} : null;
}

export interface RelaunchDependencies {
  /** Shared in-memory pending notices; leader may persist/rebuild it for 5-minute sweep. */
  pending: Map<string, ContextNotice>;
  offices: readonly string[];
  leader: string;
  /** The exact current pane ID of the caller; must equal the registered leader pane. */
  leaderPaneId: string;
  getRegistry(): Promise<RelaunchRegistry | null>;
  getSnapshot(office: string): Promise<RelaunchSnapshot | null>;
  getTask(taskId: string): Promise<RelaunchTask | null>;
  getObserverStatus(office: string): Promise<RelaunchObserverStatus>;
  /** Independently verify live leader ownership, not just a registry claim. */
  ownsLeaderPane(paneId: string): Promise<boolean>;
  /** Independently verify live pane, tab, terminal AND session against the record. */
  verifyPane(office: string, record: RelaunchRecord): Promise<boolean>;
  /** Check the office gate marker is valid for this pane and new session. */
  verifyGate(office: string, record: RelaunchRecord): Promise<boolean>;
  /** CLI wrapper: only explicit true denotes success; never call /new. */
  runRelaunch(office: string): Promise<boolean>;
  ringTask(office: string, taskId: string): Promise<void>;
}
export type RelaunchResult = {status: 'ignored'; reason: string} | {status: 'working'; request: ContextNotice; pendingKey: string} | {status: 'relaunched'; office: string; taskId: string; session: string};
export const contextPendingKey = (request: ContextNotice): string => `${request.office}:${request.taskId}`;
/** Retry only distinct pending office/task pairs; the caller owns persistence across restarts. */
export async function retryPendingContextRelaunch(deps: RelaunchDependencies): Promise<RelaunchResult[]> {
  const results: RelaunchResult[] = [];
  for (const [key, request] of [...deps.pending]) {
    if (key !== contextPendingKey(request)) { deps.pending.delete(key); continue; }
    results.push(await coordinateContextRelaunch(formatContextNotice(request), deps));
  }
  return results;
}
const inFlight = new WeakMap<Map<string, ContextNotice>, Set<string>>();
const validString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function record(registry: RelaunchRegistry | null, office: string): RelaunchRecord | null {
  const row = registry?.[office];
  if (!row || typeof row !== 'object') return null;
  const r = row as RelaunchRecord;
  return validString(r.pane_id) && validString(r.parent_tab_id) && validString(r.terminal_id) && validString(r.session) ? r : null;
}
const sameSeal = (a: RelaunchRecord, b: RelaunchRecord) => a.pane_id === b.pane_id && a.parent_tab_id === b.parent_tab_id && a.terminal_id === b.terminal_id;
const validTask = (task: RelaunchTask | null, n: ContextNotice) => task?.id === n.taskId && task.status === 'todo' && task.assignee === n.office;

/** Fail closed on any unknown observation, rejection, CLI failure or changed task. */
export async function coordinateContextRelaunch(text: unknown, deps: RelaunchDependencies): Promise<RelaunchResult> {
  const notice = parseContextNotice(text, deps.offices);
  if (!notice) return {status: 'ignored', reason: 'notice'};
  if (notice.percent !== null && notice.percent < 70) return {status: 'ignored', reason: 'threshold'};
  const {office, taskId} = notice;
  const key = contextPendingKey(notice);
  if (!(deps.pending instanceof Map)) return {status: 'ignored', reason: 'pending-unavailable'};
  // Prevent concurrent sweeps/notifications from relaunching the same office twice.
  const locked = inFlight.get(deps.pending) ?? new Set<string>();
  inFlight.set(deps.pending, locked);
  if (locked.has(office)) return {status: 'ignored', reason: 'in-flight'};
  locked.add(office);
  try {
    const before = await deps.getRegistry();
    const old = record(before, office);
    if (!old || !validString(deps.leader) || !validString(deps.leaderPaneId) ||
        before?._creators?.[deps.leader] !== deps.leaderPaneId || old.pane_id === deps.leaderPaneId)
      return {status: 'ignored', reason: 'registry'};
    const snapshot = await deps.getSnapshot(office);
    if (!snapshot || snapshot.sessionFile !== old.session ||
        (notice.percent === null ? snapshot.percent !== null :
          (typeof snapshot.percent !== 'number' || !Number.isFinite(snapshot.percent) ||
           snapshot.percent < 70 || snapshot.percent > 100)))
      return {status: 'ignored', reason: 'snapshot'};
    if (!validTask(await deps.getTask(taskId), notice)) return {status: 'ignored', reason: 'task'};
    if (!await deps.ownsLeaderPane(deps.leaderPaneId) || !await deps.verifyPane(office, old))
      return {status: 'ignored', reason: 'ownership'};
    const observer = await deps.getObserverStatus(office);
    if (observer === 'working') {
      deps.pending.set(key, notice); // map dedupes retries by office+task
      return {status: 'working', request: notice, pendingKey: key};
    }
    if (observer !== 'idle' && observer !== 'done')
      return {status: 'ignored', reason: 'observer'};
    // Re-read volatile task and seal immediately before the destructive CLI operation.
    const latest = await deps.getRegistry();
    const confirmed = record(latest, office);
    if (!confirmed || latest?._creators?.[deps.leader] !== deps.leaderPaneId ||
        !sameSeal(old, confirmed) || confirmed.session !== old.session ||
        !validTask(await deps.getTask(taskId), notice)) return {status: 'ignored', reason: 'stale-before-cli'};
    if (await deps.runRelaunch(office) !== true) return {status: 'ignored', reason: 'cli'};
    const after = await deps.getRegistry();
    const next = record(after, office);
    if (!next || after?._creators?.[deps.leader] !== deps.leaderPaneId || !sameSeal(old, next) ||
        next.session === old.session || !await deps.ownsLeaderPane(deps.leaderPaneId) ||
        !await deps.verifyPane(office, next) || !await deps.verifyGate(office, next) ||
        !validTask(await deps.getTask(taskId), notice)) return {status: 'ignored', reason: 'postcondition'};
    await deps.ringTask(office, taskId);
    deps.pending.delete(key);
    return {status: 'relaunched', office, taskId, session: next.session};
  } catch {
    return {status: 'ignored', reason: 'observation-or-effect-failed'};
  } finally {
    locked.delete(office);
  }
}
