import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-ignore pi/jiti and Node strip-types need explicit .ts extensions; project tsconfig lacks allowImportingTsExtensions.
import { AUTH_HEADER, parseEnvFile, approver, readonlyAgents } from "../lib/backend.ts";
// @ts-ignore see above
import { backendFetch, resolveIdentity } from "../lib/backend.ts";

/** Opt-in human workflow. Durable backend ACK/owner verification precedes in-memory transitions.
 * Only command audit logs are local; approvals are not inferred from local files. */
type Phase = "idle" | "planning" | "awaiting" | "executing";
export type PlanState = { phase: Phase; taskId: string; startedAt: string };
const BASE = process.env.PLAN_GATE_BASE_URL || parseEnvFile(process.cwd()).PLAN_GATE_BASE_URL || "";
export const SESSION_REF = "plan-gate";
const REMOTE_TIMEOUT_MS = 3_000;
const PHASES: ReadonlyArray<Phase> = ["idle", "planning", "awaiting", "executing"];
const idle = (): PlanState => ({ phase: "idle", taskId: "", startedAt: "" });
const rootOf = (ctx: ExtensionContext) => resolve(process.env.PLAN_GATE_ROOT || ctx.cwd);

// Estado en proceso. Sólo lo cambian restore() y commit(), siempre DESPUÉS de que el Cerebro confirme.
let mem: PlanState = idle();
export function loadPlanState(): PlanState { return { ...mem }; }
export const __test__ = { reset: () => { mem = idle(); } };

function isPlanState(v: unknown): v is PlanState {
  const s = v as Record<string, unknown> | null;
  return !!s && typeof s === "object" && PHASES.includes(s.phase as Phase) && typeof s.taskId === "string" && typeof s.startedAt === "string";
}

type Principal = { owner: string; key: string };
function principal(ctx: ExtensionContext): Principal {
  const id = resolveIdentity(ctx);
  if (!id.key || id.owner !== (process.env.PLAN_GATE_AGENT || parseEnvFile(ctx.cwd).PLAN_GATE_AGENT || "") || id.isSubagent) throw new Error("plan-gate requiere identidad de agente principal con key propia");
  return { owner: id.owner, key: id.key };
}

type Http = { ok: boolean; status: number; data: Record<string, unknown>; error: string | null };
/** Mismo patrón que http() de cerebro-continuity.ts: setTimeout con ref, NO AbortSignal.timeout. El timer de
 *  AbortSignal.timeout es unref y en el arranque de pi no dispara (medido en c937e8c2). */
async function http(p: Principal, method: "GET" | "POST", path: string, payload?: unknown): Promise<Http> {
  if (!BASE) return { ok: false, status: 0, data: {}, error: "Configure PLAN_GATE_BASE_URL" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method, signal: controller.signal,
      headers: { [AUTH_HEADER]: p.key, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const value: unknown = await response.json().catch(() => ({}));
    const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return { ok: response.ok, status: response.status, data, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, data: {}, error: controller.signal.aborted ? `timeout (${REMOTE_TIMEOUT_MS}ms)` : error instanceof Error ? error.name : "network failure" };
  } finally { clearTimeout(timer); }
}

/** D2: registra `next` en el Cerebro y SÓLO entonces lo aplica en memoria. Si falla, lanza (error visible). */
export async function commit(ctx: ExtensionContext, next: PlanState): Promise<PlanState> {
  const p = principal(ctx);
  const r = await http(p, "POST", "/checkpoint/agent-save", { session_ref: SESSION_REF, label: `plan-gate:${next.phase}`, kind: "progress", state: next });
  if (!r.ok) throw new Error(`el Cerebro no confirmó la transición a ${next.phase} (${r.error}); el estado sigue en ${mem.phase}`);
  if (r.data.agent !== p.owner) throw new Error(`el Cerebro atribuyó el estado a ${String(r.data.agent)}, no a ${p.owner}; el estado sigue en ${mem.phase}`);
  mem = { ...next };
  return loadPlanState();
}

/** D1: recupera el último estado registrado. `found:false` es «nunca hubo plan» y queda en idle sin
 *  ruido. Cualquier otra cosa ilegible deja idle y devuelve el motivo para avisarlo como error.
 *  Tarea 0585cac9 (B): un 404 NO es «nunca hubo plan». El gateway contesta `200 {found:false}` cuando no
 *  hay checkpoint (services/gateway/app.py, checkpoint_agent_latest), así que un 404 indica que falta el
 *  endpoint o la ruta está mal, y se avisa como error. */
export async function restore(ctx: ExtensionContext): Promise<string | null> {
  mem = idle();
  if (!BASE) return null; // Unconfigured installation is inactive; enter still requires durable ACK.
  let p: Principal;
  try { p = principal(ctx); } catch (e) { return e instanceof Error ? e.message : String(e); }
  const r = await http(p, "GET", `/checkpoint/agent-latest?agent=${encodeURIComponent(p.owner)}&session_ref=${encodeURIComponent(SESSION_REF)}`);
  if (r.ok && r.data.found === false) return null;
  if (!r.ok) return `no se pudo leer el estado del modo plan (${r.error})`;
  if (r.data.session_ref !== SESSION_REF) return `el Cerebro devolvió un checkpoint de otra sesión (${String(r.data.session_ref)})`;
  if (r.data.agent !== p.owner) return `el Cerebro atribuyó el checkpoint a ${String(r.data.agent)}, no a ${p.owner}`;
  if (!isPlanState(r.data.state)) return "el checkpoint del modo plan no trae un estado válido";
  mem = { phase: r.data.state.phase, taskId: r.data.state.taskId, startedAt: r.data.state.startedAt };
  return null;
}

export function planOff(ctx: ExtensionContext): Promise<PlanState> { return commit(ctx, idle()); }
export async function planEnter(ctx: ExtensionContext): Promise<PlanState> {
  // planning/awaiting: ya hay un plan en curso, no se pisa. idle o executing (ciclo anterior aprobado): plan NUEVO,
  // sin taskId heredado — si no, el próximo plan_submit reescribiría una tarea ya aprobada.
  if (mem.phase === "planning" || mem.phase === "awaiting") return loadPlanState();
  return commit(ctx, { ...idle(), phase: "planning", startedAt: new Date().toISOString() });
}

export function planGateDecision(root: string, toolName: string, input: Record<string, unknown>, cwd: string) {
  const state = mem;
  if (state.phase !== "planning" && state.phase !== "awaiting") return undefined;
  // bash y bg_run (shell de fondo de pi-background-tasks) quedan LIBRES (decisión A de configured human approver) pero REGISTRADOS.
  // Esta bitácora es lo único del modo plan que se escribe en disco (lo permite la tarea 4017c29f).
  if (toolName === "bash" || toolName === "bg_run") {
    const id = state.taskId || `pre-${state.startedAt.replace(/[^\dTZ]/g, "-")}`;
    const dir = join(root, "state/plan-gate");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), cwd, tool: toolName, command: input.command }) + "\n", { mode: 0o600 });
    return undefined;
  }
  // Sin plans/: en modo plan no hay ruta de escritura local permitida.
  let blocked = toolName === "edit" || toolName === "write";
  // LISTA DE PERMITIDOS, no de prohibidos: una lista cerrada por nombres de otra líder
  // pasaban general-purpose y _example, que también escriben. Sólo se delega a agentes sin edit/write.
  if (toolName === "subagent") blocked = !readonlyAgents().includes(String(input.subagent_type ?? "").toLowerCase());
  return blocked ? { block: true as const, reason: "Modo plan: escritura/delegación ejecutora bloqueada. Esperá aprobación en la tarea y usá plan_check, o pedile a configured human approver `/plan off` (override humano)." } : undefined;
}
function logPath(root: string, state: PlanState) {
  const id = state.taskId || `pre-${state.startedAt.replace(/[^\dTZ]/g, "-")}`;
  return join(root, "state/plan-gate", `${id}.jsonl`);
}
export function bashLogComment(root: string, state: PlanState): string {
  const path = logPath(root, state);
  const prePath = state.taskId ? logPath(root, { ...state, taskId: "" }) : "";
  const lines = [prePath, path].filter(p => p && existsSync(p)).flatMap(p => readFileSync(p, "utf8").trimEnd().split("\n").filter(Boolean));
  return `Log bash modo plan (${lines.length} comandos; primeros ${Math.min(150, lines.length)}):\n\`\`\`json\n${lines.slice(0, 150).join("\n").replace(/```/g, "` ` `")}\n\`\`\``;
}
type Event = { agent?: string; kind?: string; from_status?: string; to_status?: string; body?: string };
export function planVerdict(status: string, events: Event[]): "approved" | "rejected" | "pending" {
  const last = [...events].reverse().find(e => e.kind === "review" && e.from_status === "submitted");
  if (status === "done" && last?.to_status === "done" && /^pass(?:\s|:|$)/i.test(last.body || "") && last.agent?.toLowerCase() === approver()) return "approved";
  if (status === "in_progress" && last?.to_status === "in_progress" && /^needs_changes(?:\s|:|$)/i.test(last.body || "") && last.agent?.toLowerCase() === approver()) return "rejected";
  return "pending";
}
async function api(ctx: ExtensionContext, method: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const id = principal(ctx);
  const result = await backendFetch(BASE + path, method, { "Content-Type": "application/json", [AUTH_HEADER]: id.key }, body);
  if (result.status < 200 || result.status >= 300) throw new Error(`Cerebro ${path}: HTTP ${result.status} ${result.bodyText.slice(0, 400)}`);
  let data: any;
  try { data = JSON.parse(result.bodyText); }
  catch { throw new Error(`Cerebro ${path}: respuesta no JSON (${result.bodyText.slice(0, 160)})`); }
  if (data.error) throw new Error(`Cerebro ${path}: ${data.error}`);
  return data;
}
async function review(ctx: ExtensionContext, state: PlanState) {
  if (!state.taskId) throw new Error("No hay tarea vinculada: usá plan_submit primero");
  const q = `?task_id=${encodeURIComponent(state.taskId)}`;
  const task = await api(ctx, "GET", `/task/get${q}`);
  const activity = await api(ctx, "GET", `/task/activity${q}`);
  return { task, events: activity.events as Event[], verdict: planVerdict(task.status, activity.events) };
}
const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) });
const error = (e: unknown) => answer(`Modo plan: ${e instanceof Error ? e.message : String(e)}. El bloqueo permanece activo.`, true);

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const why = await restore(ctx);
    if (why) { try { ctx.ui.notify(`Modo plan: ${why}. Queda inactivo (idle) hasta que el Cerebro confirme otro estado.`, "error"); } catch { /* ui no-op */ } }
  });
  pi.registerCommand("plan", {
    description: "Modo plan: /plan [título], /plan status, /plan off (override humano)",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        const result = action === "off" ? await planOff(ctx) : action === "status" ? loadPlanState() : await planEnter(ctx);
        ctx.ui.notify(`Modo plan: ${result.phase}${result.taskId ? ` | tarea ${result.taskId}` : ""}${action && !["off", "status"].includes(action) ? ` | ${action}` : ""}`, "info");
      } catch (e) { ctx.ui.notify(`Modo plan: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    },
  });
  pi.on("tool_call", (event, ctx) => {
    try { return planGateDecision(rootOf(ctx), event.toolName, event.input as Record<string, unknown>, ctx.cwd); }
    catch (e) { return { block: true, reason: `Modo plan: error registrando/controlando llamada (${String(e)}); bloqueada por seguridad. /plan off (configured human approver).` }; }
  });
  pi.registerTool({
    name: "plan_mode", label: "Modo plan", description: "Entra, consulta o intenta salir del modo plan; exit requiere firma de configured human approver en Cerebro.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("enter"), Type.Literal("status"), Type.Literal("exit")]) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = loadPlanState();
        if (params.action === "status") return answer(JSON.stringify(state));
        if (params.action === "enter") return answer(JSON.stringify(await planEnter(ctx)));
        if (state.phase === "idle") return answer("Modo plan ya inactivo");
        if (state.phase !== "executing") {
          const result = await review(ctx, state);
          if (result.verdict !== "approved") return answer(`Exit rechazado: tarea ${state.taskId} ${result.verdict}; requiere review pass de configured human approver. /plan off sólo por configured human approver.`, true);
        } else await review(ctx, state).then(r => { if (r.verdict !== "approved") throw new Error("la aprobación ya no está vigente"); });
        // Con la aprobación verificada, exit CIERRA el ciclo: vuelve a idle y suelta el taskId.
        await commit(ctx, idle());
        return answer(`Ciclo cerrado: plan aprobado en tarea ${state.taskId}; modo plan inactivo.`);
      } catch (e) { return error(e); }
    },
  });
  pi.registerTool({
    name: "plan_submit", label: "Enviar plan", description: "Envía el plan como descripción de una tarea al gate humano de configured human approver (sin archivo local).",
    parameters: Type.Object({ title: Type.String(), plan_markdown: Type.String(), project: Type.String(), organization: Type.Optional(Type.String()), parent_id: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const root = rootOf(ctx), state = loadPlanState();
        if (state.phase !== "planning") throw new Error("plan_submit requiere fase planning");
        if (!params.title.trim() || !params.plan_markdown.trim() || !params.project.trim()) throw new Error("título, plan y proyecto obligatorios");
        let taskId = state.taskId;
        if (!taskId) {
          const created = await api(ctx, "POST", "/task/create", { title: params.title, description: params.plan_markdown, project: params.project, organization: params.organization || "", parent_id: params.parent_id || "", assignee: approver(), tags: ["plan-gate"] });
          taskId = created.id || created.task_id;
          if (!taskId) throw new Error(`Cerebro /task/create sin id: ${JSON.stringify(created).slice(0, 300)}`);
          // Registrar ANTES de cualquier operación posterior: no crear duplicados si cae la red.
          try { await commit(ctx, { ...state, taskId }); }
          catch (e) { throw new Error(`tarea ${taskId} creada pero NO vinculada al modo plan: ${e instanceof Error ? e.message : String(e)}. No reenvíes sin revisar esa tarea`); }
          await api(ctx, "POST", "/task/claim", { task_id: taskId });
        } else {
          const current = await api(ctx, "GET", `/task/get?task_id=${encodeURIComponent(taskId)}`);
          // Si falló el claim tras crear la tarea, retomar el mismo id; nunca duplicar create.
          if (current.status === "todo") await api(ctx, "POST", "/task/claim", { task_id: taskId });
          else if (current.status !== "in_progress") throw new Error(`Reenvío sólo tras needs_changes (in_progress); estado ${current.status}`);
          await api(ctx, "POST", "/task/update", { task_id: taskId, description: params.plan_markdown });
        }
        const latest = loadPlanState();
        await api(ctx, "POST", "/task/comment", { task_id: taskId, body: bashLogComment(root, latest) });
        await api(ctx, "POST", "/task/submit", { task_id: taskId, note: "Plan para aprobación de configured human approver" });
        await commit(ctx, { ...latest, phase: "awaiting" });
        return answer(`Plan enviado: tarea ${taskId} submitted, asignada a configured human approver; el plan es la descripción de la tarea`);
      } catch (e) { return error(e); }
    },
  });
  pi.registerTool({
    name: "plan_check", label: "Revisar plan", description: "Lee tarea y actividad: aprobación, rechazo o pendiente; la descripción de configured human approver es autoritativa.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const state = loadPlanState();
        const { task, events, verdict } = await review(ctx, state);
        const comments = events.filter(e => e.kind === "comment").map(e => ({ agent: e.agent, body: e.body }));
        if (verdict === "approved") {
          await commit(ctx, { ...state, phase: "executing" });
          return answer(JSON.stringify({ verdict, taskId: state.taskId, authoritativePlan: task.description, comments }));
        }
        if (verdict === "rejected") {
          await commit(ctx, { ...state, phase: "planning" });
          return answer(JSON.stringify({ verdict, corrections: events.filter(e => e.agent?.toLowerCase() === approver() && (e.kind === "comment" || e.kind === "review")).map(e => e.body), authoritativePlan: task.description }));
        }
        return answer(`Pendiente de aprobación en tarea ${state.taskId}; estado ${task.status}.`);
      } catch (e) { return error(e); }
    },
  });
}
