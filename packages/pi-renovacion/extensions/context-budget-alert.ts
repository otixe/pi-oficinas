import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../lib/config.ts";

function truncate(s: string, n: number): string {
  return Array.from(s).length > n ? `${Array.from(s).slice(0, n).join("")}…` : s;
}

/** Context usage alerts; observer only. Does not change compaction settings or create sessions.
 * Installed means enabled unless CONTEXT_ALERT=0. Usage/cost originate from provider reports;
 * missing costs are represented as zero, not a verified free request. Optional Telegram delivery
 * failure is recorded locally and does not abort the turn. */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const FALLBACK_REL_PATH = join("state", "context-budget-alert.jsonl");
const SEND_TIMEOUT_MS = 8000;
const TELEGRAM_PROMPT_HEAD = "[telegram";

/** Ventana de contexto asumida. Opus 5 / Sonnet 5 en Bedrock: 1.000.000 (verificado en models-store.json). */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

function envRaw(cwd: string, key: string): string {
  const env=parseEnvFile(cwd);
  return (process.env[key] ?? env[key] ?? "").trim();
}

/** Default ON (ver cabecera). Sólo un "0/false/off/no" explícito la apaga. */
export function isEnabled(cwd: string): boolean {
  const raw = envRaw(cwd, "CONTEXT_ALERT");
  if (raw === "") return true;
  return !/^(0|false|off|no)$/i.test(raw);
}

export function resolveContextWindow(cwd: string, modelWindow?: number): number {
  const n = Number.parseInt(envRaw(cwd, "CONTEXT_WINDOW"), 10);
  return Number.isFinite(n) && n > 0 ? n : (typeof modelWindow === "number" && modelWindow > 0 ? modelWindow : DEFAULT_CONTEXT_WINDOW);
}

/**
 * Umbrales en porcentaje, ordenados y deduplicados. Default `[80]`.
 * Se ignoran los valores fuera de (0, 100]; si no queda ninguno válido se
 * cae al default en vez de quedar mudo (un aviso mal configurado que no avisa
 * es peor que uno ruidoso).
 */
export function resolveThresholds(cwd: string): number[] {
  const raw = envRaw(cwd, "CONTEXT_ALERT_PCT");
  const parsed = raw
    .split(/[,\s;]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  const uniq = [...new Set(parsed)].sort((a, b) => a - b);
  return uniq.length > 0 ? uniq : [80];
}

function forcedThrowPoint(cwd: string): string | null {
  const v = envRaw(cwd, "CONTEXT_ALERT_FORCE_THROW");
  return v || null;
}

// ---------------------------------------------------------------------------
// Núcleo testeable — sin I/O, sin pi, sin Telegram
// ---------------------------------------------------------------------------

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * Tokens de CONTEXTO de un request: lo que viajó de entrada, no lo generado.
 * Mismo criterio que `calculateContextTokens` de pi: input + cacheRead +
 * cacheWrite. `output` queda AFUERA a propósito — no es contexto enviado.
 */
export function contextTokensOf(usage: UsageLike | null | undefined): number {
  if (!usage) return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite);
}

/** Extrae el `usage` de un AgentMessage sin acoplarse a su tipo (duck-typing tolerante). */
export function usageOf(message: unknown): UsageLike | null {
  if (!message || typeof message !== "object") return null;
  const u = (message as { usage?: unknown }).usage;
  return u && typeof u === "object" ? (u as UsageLike) : null;
}

export interface SessionTotals {
  requests: number;
  costUsd: number;
}

export interface AlertDecision {
  /** Umbral cruzado que hay que anunciar, o null si no corresponde avisar. */
  threshold: number | null;
  contextTokens: number;
  pct: number;
}

/**
 * Decide si hay que avisar. Devuelve el umbral MÁS ALTO cruzado que todavía no
 * se anunció — así un salto grande en un solo turno (una lectura enorme) no
 * dispara tres mensajes seguidos, sino el que de verdad importa.
 */
export function decideAlert(
  contextTokens: number,
  contextWindow: number,
  thresholds: number[],
  alreadyFired: ReadonlySet<number>,
): AlertDecision {
  const pct = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  let hit: number | null = null;
  for (const t of thresholds) {
    if (pct >= t && !alreadyFired.has(t)) hit = t;
  }
  return { threshold: hit, contextTokens, pct };
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

function fmtUsd(n: number): string {
  return n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildAlertText(args: {
  threshold: number;
  pct: number;
  contextTokens: number;
  contextWindow: number;
  turnCostUsd: number;
  totals: SessionTotals;
  anchorRelPath: string;
}): string {
  const { threshold, pct, contextTokens, contextWindow, turnCostUsd, totals, anchorRelPath } = args;
  const remaining = Math.max(0, contextWindow - contextTokens);
  return [
    `⚠️ CONTEXTO AL ${pct.toFixed(1)}% (umbral ${threshold}%) — conviene RENOVAR SESIÓN`,
    "",
    `  contexto:  ${fmtInt(contextTokens)} / ${fmtInt(contextWindow)} tokens`,
    `  queda:     ${fmtInt(remaining)} tokens antes del borde`,
    `  este turno costó:  USD ${fmtUsd(turnCostUsd)}`,
    `  sesión acumulada:  USD ${fmtUsd(totals.costUsd)} en ${totals.requests} requests`,
    "",
    "  Este aviso NO cambia tu configuración de compactación ni corta la sesión.",
    "  Revisá tus ajustes y guardá el estado de trabajo antes de renovar.",
    "",
    `  Para renovar: sesión nueva. El ancla en disco (${anchorRelPath}) trae el`,
    "  último cierre con firma y fecha.",
    "  ⚠️ Si hay una tarea a medio hacer, pedí cosecha ANTES de cortar: el ancla",
    "  guarda firma, mensajes y artefactos — NO los hallazgos intermedios.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Envío — mismo patrón de import perezoso que thinking-to-telegram.ts
// ---------------------------------------------------------------------------

export interface TelegramSendOk {
  ok: true;
}
export interface TelegramSendFail {
  ok: false;
  reason: string;
  message: string;
}
export type TelegramSendResult = TelegramSendOk | TelegramSendFail;
export type TelegramSendFn = (
  view: { text: string; parseMode?: "plain" | "html" | "markdown" },
  options: { scope: { kind: "active-turn" } },
) => Promise<TelegramSendResult>;

let cachedSendFn: TelegramSendFn | null = null;

const DELIVERY_SPEC = "@llblab/pi-telegram/delivery";
type Importer = (specifier: string) => Promise<unknown>;

/** Tarea 0585cac9 (D): el mismo arreglo que guardrail-watch.ts (4017c29f + 0585cac9 A), copiado igual a
 *  propósito para no agregar un archivo nuevo a los cuerpos. pi instala pi-telegram en
 *  `<.pi>/npm/node_modules/`, que no está en la cadena de resolución desde `.pi/extensions/`, así que el
 *  import pelado fallaba con «Cannot find module». Primero se prueba el import pelado; si falla, se resuelve
 *  anclado en `<.pi>/npm/` y SOLO se acepta una ruta (realpath) dentro de `<.pi>/npm/node_modules/`. En
 *  cualquier otro caso se vuelve a lanzar el error original. El runtime de entrega vive en globalThis, así
 *  que una segunda carga del módulo lo comparte. */
export async function loadDeliveryModule(
  importer: Importer = (s) => import(s),
  extensionDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<{ sendTelegramView: TelegramSendFn }> {
  try {
    return (await importer(DELIVERY_SPEC)) as { sendTelegramView: TelegramSendFn };
  } catch (bare) {
    let resolved: string, allowed: string;
    try {
      allowed = realpathSync(join(extensionDir, "..", "npm", "node_modules"));
      resolved = realpathSync(createRequire(join(extensionDir, "..", "npm", "package.json")).resolve(DELIVERY_SPEC));
    } catch { throw bare; } // sin .pi/npm: el error original es el que explica
    if (!resolved.startsWith(`${allowed}${sep}`)) throw bare; // resolvió fuera de <.pi>/npm/node_modules
    return (await importer(resolved)) as { sendTelegramView: TelegramSendFn };
  }
}

async function loadSendTelegramView(cwd: string): Promise<TelegramSendFn> {
  if (cachedSendFn) return cachedSendFn;
  const mod = await loadDeliveryModule(undefined, join(cwd, ".pi", "extensions"));
  cachedSendFn = mod.sendTelegramView;
  return cachedSendFn;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout (${ms}ms) esperando ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Degradación ruidosa, nunca silenciosa
// ---------------------------------------------------------------------------

function appendFallback(cwd: string, entry: Record<string, unknown>): void {
  try {
    const path = join(cwd, FALLBACK_REL_PATH);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, {encoding:"utf8",mode:0o600});
  } catch {
    // Último recurso: no arriesgar el turno por no poder escribir el registro.
  }
}

function safeNotify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(msg, level);
  } catch {
    // ctx.ui puede ser no-op (print/json) o lanzar en un ctx stale.
  }
}

export function isTelegramOriginPrompt(prompt: string | null | undefined): boolean {
  const trimmed = (prompt ?? "").trimStart();
  return trimmed.startsWith(`${TELEGRAM_PROMPT_HEAD}]`) || trimmed.startsWith(`${TELEGRAM_PROMPT_HEAD}|`);
}

/** Ancla por owner (misma convención que cerebro-continuity.ts). */
function anchorRelPathForOwner(owner: string | null | undefined): string {
  const safe = (owner ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "agent";
  return join("state", `continuity-anchor-${safe}.json`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let fired = new Set<number>();
  let totals: SessionTotals = { requests: 0, costUsd: 0 };
  let currentPromptIsTelegram = false;
  let maxContextSeen = 0;

  pi.on("session_start", async () => {
    fired = new Set<number>();
    totals = { requests: 0, costUsd: 0 };
    currentPromptIsTelegram = false;
    maxContextSeen = 0;
  });

  pi.on("before_agent_start", async (event) => {
    try {
      currentPromptIsTelegram = isTelegramOriginPrompt(event.prompt);
    } catch {
      currentPromptIsTelegram = false;
    }
    // Nunca retorna nada: SÓLO observa.
  });

  pi.on("turn_end", async (event, ctx) => {
    const cwd = ctx.cwd;
    try {
      if (!isEnabled(cwd)) return;

      if (forcedThrowPoint(cwd) === "turn_end") {
        throw new Error(
          "CONTEXT_ALERT_FORCE_THROW=turn_end: fallo inyectado a propósito (prueba reproducible del catch-all).",
        );
      }

      const usage = usageOf(event.message);
      const ctxTokens = contextTokensOf(usage);
      if (ctxTokens <= 0) return; // turno sin usage (tool-only, error del proveedor): nada que medir.

      totals.requests += 1;
      const turnCost = typeof usage?.cost?.total === "number" ? usage.cost.total : 0;
      totals.costUsd += turnCost;
      maxContextSeen = Math.max(maxContextSeen, ctxTokens);

      // Defensivo: si el contexto observado supera la ventana asumida, la
      // asunción está mal (modelo con otra ventana) — se usa lo observado para
      // no reportar un 140% absurdo ni quedarse mudo.
      const declared = resolveContextWindow(cwd, ctx.model?.contextWindow);
      const contextWindow = Math.max(declared, maxContextSeen);

      const thresholds = resolveThresholds(cwd);
      const decision = decideAlert(ctxTokens, contextWindow, thresholds, fired);
      if (decision.threshold === null) return;

      fired.add(decision.threshold);

      const owner = (ctx as { identity?: { owner?: string } }).identity?.owner ?? null;
      const text = buildAlertText({
        threshold: decision.threshold,
        pct: decision.pct,
        contextTokens: ctxTokens,
        contextWindow,
        turnCostUsd: turnCost,
        totals: { ...totals },
        anchorRelPath: anchorRelPathForOwner(owner),
      });

      // Registro durable SIEMPRE, antes de intentar cualquier envío: si el
      // canal falla, el aviso no se pierde.
      appendFallback(cwd, {
        written_at: new Date().toISOString(),
        kind: "alert",
        threshold: decision.threshold,
        pct: Number(decision.pct.toFixed(2)),
        context_tokens: ctxTokens,
        context_window: contextWindow,
        turn_cost_usd: turnCost,
        session_cost_usd: Number(totals.costUsd.toFixed(4)),
        session_requests: totals.requests,
      });

      safeNotify(ctx, `contexto al ${decision.pct.toFixed(1)}% (${fmtInt(ctxTokens)} tokens) — conviene renovar sesión`, "warning");

      if (currentPromptIsTelegram) {
        const sendFn = await loadSendTelegramView(cwd);
        const result = await withTimeout(
          sendFn({ text, parseMode: "plain" }, { scope: { kind: "active-turn" } }),
          SEND_TIMEOUT_MS,
          "sendTelegramView",
        );
        if (!result.ok) {
          appendFallback(cwd, {
            written_at: new Date().toISOString(),
            kind: "send-failed",
            reason: result.reason,
            message: truncate(String(result.message), 300),
          });
          safeNotify(ctx, `context-budget-alert: no se pudo enviar por Telegram (${result.reason}).`, "warning");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      appendFallback(cwd, {
        written_at: new Date().toISOString(),
        kind: "internal-error",
        error: truncate(message, 2000),
      });
      safeNotify(
        ctx,
        "context-budget-alert: excepción interna atrapada -- ver state/context-budget-alert.jsonl",
        "warning",
      );
    }
  });
}
