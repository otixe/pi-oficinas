// MIT. Agent Memory Access; see README for identity and exposure limits.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  AMBIGUOUS_OWNER,
  AUTH_HEADER,
  IDENTITY_BUILD,
  LEADER,
  explainIdentityFailure,
  hasAgentInstructionsTag,
  hasAgentTag,
  hasSubAgentContextTag,
  hasSubagentShape,
  parseEnvFile,
  resolveAgentNameFromPrompt,
  resolveIdentityFrom,
  safeSubagentShapeSignal,
  type Identity,
} from "../lib/cerebro-identity.ts";

import { cerebroExposure, readCerebroSurface } from "../lib/cerebro-surface.ts";







export {
  AMBIGUOUS_OWNER,
  AUTH_HEADER,
  LEADER,
  hasAgentInstructionsTag,
  hasAgentTag,
  hasSubAgentContextTag,
  hasSubagentShape,
  parseEnvFile,
  resolveAgentNameFromPrompt,
  resolveIdentityFrom,
  safeSubagentShapeSignal,
};
export type { Identity };











































const MCP_URL = process.env.CEREBRO_MCP_URL || parseEnvFile(process.cwd()).CEREBRO_MCP_URL || "http://127.0.0.1:8766/mcp";
const TOOL_PREFIX = "cb_";
const CACHE_REL = join(".pi", "cache", "cerebro-mcp-tools.json");
const DISCOVERY_TIMEOUT_MS = 10_000;










function resolveAgentName(ctx: ExtensionContext): string | null {
  try {
    return resolveAgentNameFromPrompt(ctx.getSystemPrompt());
  } catch {
    return null;
  }
}


function currentSystemPrompt(ctx: ExtensionContext): string {
  try {
    return ctx.getSystemPrompt();
  } catch {
    return "";
  }
}














const AGENT_TAG_LABEL = ["active", "agent"].join("_");
const SUBAGENT_CONTEXT_LABEL = "sub_" + ["agent", "context"].join("_");




const INSTRUCTIONS_TAG_LABEL = ["agent", "instructions"].join("_");










export const EXT_BUILD = "0.1.0-ama";










export function resolveIdentity(ctx: ExtensionContext): Identity {
  return resolveIdentityFrom(
    resolveAgentName(ctx),
    parseEnvFile(ctx.cwd),
    process.env,
    safeSubagentShapeSignal(() => ctx.getSystemPrompt()),
  );
}





interface Session {
  id: string;
  initPromise?: Promise<string>;
}
const sessions = new Map<string, Session>();
let rpcId = 1;

export function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {

    }
  }
  let last: unknown;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {

    }
  }
  return last;
}

function authHeaders(key: string, sid?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  h[AUTH_HEADER] = key;
  if (sid) h["mcp-session-id"] = sid;
  return h;
}

async function rpc(
  key: string,
  sid: string | undefined,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: authHeaders(key, sid),
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
}

async function initSession(key: string, signal?: AbortSignal): Promise<string> {
  const res = await rpc(
    key,
    undefined,
    {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cerebro-mcp-ext", version: "2.0" },
      },
    },
    signal,
  );
  const sid = res.headers.get("mcp-session-id");
  if (!sid) throw new Error(`MCP initialize sin mcp-session-id (HTTP ${res.status})`);
  await rpc(key, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {});
  return sid;
}

async function getSession(key: string, signal?: AbortSignal): Promise<string> {
  const existing = sessions.get(key);
  if (existing) {
    if (existing.id) return existing.id;
    if (existing.initPromise) return existing.initPromise;
  }
  const entry: Session = { id: "" };
  const p = initSession(key, signal)
    .then((id) => {
      entry.id = id;
      delete entry.initPromise;
      return id;
    })
    .catch((err) => {
      sessions.delete(key);
      throw err;
    });
  entry.initPromise = p;
  sessions.set(key, entry);
  return p;
}

interface RpcBody {
  error?: { message?: string };
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: McpToolDef[];
  };
}


async function mcpRequest(
  key: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RpcBody> {
  const send = async () => {
    const sid = await getSession(key, signal);
    return rpc(key, sid, { jsonrpc: "2.0", id: rpcId++, method, params }, signal);
  };

  let res = await send();
  if (res.status === 400 || res.status === 404) {
    sessions.delete(key);
    res = await send();
  }

  const text = await res.text();
  const body = parseMcpBody(text) as RpcBody | undefined;
  if (!body) throw new Error(`Respuesta MCP no parseable (HTTP ${res.status}): ${text.slice(0, 300)}`);
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body;
}





































const MCP_CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CEREBRO_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

export async function mcpCall(
  key: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MCP_CALL_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  let body: RpcBody;
  try {
    body = await mcpRequest(
      key,
      "tools/call",
      { name: toolName, arguments: args },
      combinedSignal,
    );
  } catch (err: any) {



    const porTimeout = ctrl.signal.aborted;
    const porCancelacion = !porTimeout && !!signal?.aborted;
    if (porTimeout) {
      const e = new Error(
        `timeout: ${toolName} no respondió en ${MCP_CALL_TIMEOUT_MS}ms (techo de mcpCall, configurable con CEREBRO_MCP_TIMEOUT_MS)`,
      );
      (e as any).reason = "timeout";
      throw e;
    }
    if (porCancelacion) {
      const e = new Error(
        `cancelled: ${toolName} abortado por el llamador antes del techo de ${MCP_CALL_TIMEOUT_MS}ms`,
      );
      (e as any).reason = "cancelled";
      throw e;
    }
    throw err; // network-error / error de protocolo MCP: se preserva el mensaje original.
  } finally {
    clearTimeout(timer);
  }
  const out = (body.result?.content ?? [])
    .map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
    .join("\n")
    .trim();
  if (body.result?.isError) throw new Error(out || "la tool devolvió isError");
  return out || "(sin contenido)";
}




interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export async function discoverTools(key: string): Promise<McpToolDef[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const body = await mcpRequest(key, "tools/list", {}, ac.signal);
    const tools = body.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) throw new Error("tools/list vacío");
    return tools;
  } finally {
    clearTimeout(timer);
  }
}

function readCache(cwd: string): McpToolDef[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, CACHE_REL), "utf8")) as { tools?: McpToolDef[] };
    return Array.isArray(raw.tools) && raw.tools.length > 0 ? raw.tools : null;
  } catch {
    return null;
  }
}

function writeCache(cwd: string, tools: McpToolDef[]): void {
  try {
    const path = join(cwd, CACHE_REL);
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, JSON.stringify({ updated: new Date().toISOString(), tools }, null, 2), "utf8");
  } catch {

  }
}






export function toTypeBox(spec: McpToolDef): TSchema {
  const props = spec.inputSchema?.properties ?? {};
  const required = new Set(spec.inputSchema?.required ?? []);
  const shape: Record<string, TSchema> = {};

  for (const [name, raw] of Object.entries(props)) {
    const t = Array.isArray(raw.type) ? raw.type.find((x) => x !== "null") : raw.type;
    const opts: Record<string, unknown> = {};
    if (typeof raw.description === "string") opts.description = raw.description;
    if (raw.default !== undefined) {
      opts.description = `${opts.description ? `${opts.description} · ` : ""}default: ${JSON.stringify(raw.default)}`;
    }

    let base: TSchema;
    switch (t) {
      case "integer":
        base = Type.Integer(opts);
        break;
      case "number":
        base = Type.Number(opts);
        break;
      case "boolean":
        base = Type.Boolean(opts);
        break;
      case "array":
        base = Type.Array(Type.Unknown(), opts);
        break;
      case "object":
        base = Type.Object({}, { ...opts, additionalProperties: true });
        break;
      default:
        base = Type.String(opts);
    }
    shape[name] = required.has(name) ? base : Type.Optional(base);
  }
  return Type.Object(shape);
}















export function isLeaderKeyedTool(name: string): boolean {
  return name.startsWith("cerebro_") && name !== "cerebro_fetch";
}


export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const { mode: surfaceMode, perfil: surfacePerfil } = readCerebroSurface(cwd);
  const env = parseEnvFile(cwd);

  const bootAgent = process.env.PI_AGENT_NAME?.toLowerCase() || null;
  const bootIdentity = resolveIdentityFrom(bootAgent, env, process.env);















  const discoveryKey = bootIdentity.key;

  let tools: McpToolDef[] = [];
  let source = "live";
  try {
    if (!discoveryKey) throw new Error("sin key de auth para descubrir tools");
    tools = await discoverTools(discoveryKey);
    writeCache(cwd, tools);
  } catch (err) {
    const cached = readCache(cwd);
    if (cached) {
      tools = cached;
      source = `cache (descubrimiento falló: ${err instanceof Error ? err.message : String(err)})`;
    } else {
      source = `sin tools (descubrimiento falló y no hay caché: ${
        err instanceof Error ? err.message : String(err)
      })`;
    }
  }

  for (const spec of tools) {
    pi.registerTool({
      name: `${TOOL_PREFIX}${spec.name}`,
      exposure: cerebroExposure(surfaceMode, `${TOOL_PREFIX}${spec.name}`, surfacePerfil),
      label: `Cerebro: ${spec.name}`,
      description: spec.description ?? spec.name,
      parameters: toTypeBox(spec),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const id = resolveIdentity(ctx);

        if (!id.key) {


          const why = explainIdentityFailure(id);
          return {
            content: [{ type: "text", text: why }],
            isError: true,
            details: { tool: spec.name, identity: id.owner, authenticated: false },
          };
        }

        const args: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params ?? {})) {
          if (v !== undefined && v !== null) args[k] = v;
        }

        try {
          const text = await mcpCall(id.key, spec.name, args, signal);
          return {
            content: [{ type: "text", text }],
            details: { tool: spec.name, identity: id.owner },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error en ${spec.name} (identidad ${id.owner}): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
            isError: true,
            details: { tool: spec.name, identity: id.owner },
          };
        }
      },
    });
  }


  pi.on("tool_call", (event, ctx) => {
    if (!isLeaderKeyedTool(event.toolName)) return;
    const agent = resolveAgentName(ctx);
    if (!agent) return; // el líder sí puede usar su propio cliente MCP
    return {
      block: true,
      reason:
        `"${event.toolName}" viaja con la key del LÍDER: usarla haría que tu escritura ` +
        `en el Cerebro quede atribuida a "${LEADER}" y no a "${agent}", neutralizando el RBAC. ` +
        `Usá la tool equivalente "${TOOL_PREFIX}${event.toolName.replace(/^cerebro_(cerebro_)?/, "")}", ` +
        `que autentica con tu propia identidad.`,
    };
  });




  pi.registerTool({
    name: `${TOOL_PREFIX}whoami`,
    label: "Cerebro: whoami",
    description:
      "Reporta con qué identidad este agente escribe en el Cerebro: subagente o líder, " +
      "qué variable de entorno aporta la key, y si esa key autentica de verdad contra el " +
      "servidor MCP. Nunca expone el valor de la key. Usalo para verificar la atribución " +
      "antes de escribir memoria, vault o tablero.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const id = resolveIdentity(ctx);




      const promptNow = currentSystemPrompt(ctx);




      const marcadores =
        `${SUBAGENT_CONTEXT_LABEL}=${hasSubAgentContextTag(promptNow) ? "SI" : "no"} ` +
        `${AGENT_TAG_LABEL}=${hasAgentTag(promptNow) ? "SI" : "no"} ` +
        `${INSTRUCTIONS_TAG_LABEL}=${hasAgentInstructionsTag(promptNow) ? "SI" : "no"}`;
      const lines = [
        `build_extension    : ${EXT_BUILD}`,
        `build_identidad    : ${IDENTITY_BUILD} (.pi/lib/cerebro-identity.ts, compartido con cerebro_fetch)`,
        `identidad_resuelta : ${id.owner}${id.isSubagent ? " (subagente)" : " (líder)"}`,
        `origen_de_la_key   : ${id.varName}`,
        `key_presente       : ${id.key ? "sí" : "NO"}`,
        `tools_cb           : ${tools.length} (${source})`,
        `superficie_cb      : ${surfaceMode} (AMA — Agent Memory Access; opt-in local; proceso nuevo para validar)`,
        `perfil_cb          : ${surfacePerfil}`,
        `fail_closed_tag    : ${typeof hasAgentTag === "function" ? "activo (detección laxa + AMBIGUOUS)" : "AUSENTE — código viejo"}`,
        `marcadores_prompt  : ${marcadores}`,
      ];

      if (!id.key) {
        lines.push(
          `auth_verificada    : no se pudo probar (sin key)`,
          ``,
          `Las tools ${TOOL_PREFIX}* van a fallar de forma explícita. No caen a la key del líder: ` +
            `eso falsearía la atribución.`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: true,
          details: { identity: id.owner, isSubagent: id.isSubagent, authenticated: false },
        };
      }

      try {
        await mcpCall(id.key, "memory_stats", {}, signal);
        lines.push(`auth_verificada    : sí — el servidor aceptó esta key`);
      } catch (err) {
        lines.push(
          `auth_verificada    : NO — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      lines.push(
        ``,
        `Nota: esto prueba que la key autentica, no a quién se la atribuye el servidor. ` +
          `Para verificar la ATRIBUCIÓN, escribí con ${TOOL_PREFIX}checkpoint_agent_save y leelo ` +
          `con ${TOOL_PREFIX}checkpoint_agent_latest(agent="${id.owner}").`,
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { identity: id.owner, isSubagent: id.isSubagent },
      };
    },
  });
}
