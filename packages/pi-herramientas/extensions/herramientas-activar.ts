// Meta-tool chica. El catálogo (una línea por grupo) vive en la descripción.
// Las schemas del resto no entran al request hasta que esta tool las activa.
// Pi aplica setActiveTools en el próximo request, no en el que ya está en vuelo.
// Patrón: pi-lens pi_lens_activate_tools sobre getActiveTools/setActiveTools.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  META_TOOL,
  classifyRequest,
  describeHerramientas,
  loadHerramientasConfig,
  projectActiveSet,
  resolverInicial,
  sameSet,
  type HerramientasConfig,
} from "../lib/herramientas-activar.ts";

export function configPath(cwd: string): string {
  return join(cwd, ".pi", "herramientas.json");
}

export function readConfig(cwd: string): HerramientasConfig | null {
  const path = configPath(cwd);
  if (!existsSync(path)) return null;
  try {
    return loadHerramientasConfig(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface HerramientasPi {
  getAllTools(): { name: string; exposure?: string }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: { grupo?: string; nombres?: string[] }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
  }): void;
  on(event: "session_start" | "before_agent_start", handler: (event: unknown, ctx: ExtensionContext) => void): void;
}

export function attachHerramientas(pi: HerramientasPi): { extras: () => string[] } {
  let extras: string[] = [];
  let registeredTool = false;
  // F4: universe of a `"base": "*"` config = tools registered with direct exposure (or
  // model-only / no exposure). pi already filters getAllTools() by --tools (see
  // test_agent_template), so in an office it is exactly the profile allowlist. It is NOT taken
  // from getActiveTools(): on resume (--session) or /reload pi can restore a restricted active
  // set, and deferred groups would no longer be activatable. hidden/codemode/deferred never enter.
  const universo = (): string[] | null => {
    try {
      const tools = pi.getAllTools();
      if (!Array.isArray(tools)) return null;
      return tools
        .filter((tool) => typeof tool.name === "string" && (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only"))
        .map((tool) => tool.name);
    } catch {
      return null;
    }
  };
  const configFor = (cwd: string): HerramientasConfig | null => {
    const raw = readConfig(cwd);
    const config = resolverInicial(raw, universo());
    // Existing config vocabulary: base '*' + no groups = fixed direct loadout.
    // Desired order is canonical WHEN membership changes. Once startup/host
    // has finalized an equivalent active set, preserve its order: sorting it
    // during before_agent_start would invalidate a previously frozen prompt.
    return raw?.inicial && Object.keys(raw.grupos).length === 0 && config
      ? { ...config, base: config.base.slice().sort() }
      : config;
  };

  const ensureRegistered = () => {
    if (registeredTool) return;
    pi.registerTool(tool);
    registeredTool = true;
  };

  const registered = () => {
    try {
      const tools = pi.getAllTools();
      return Array.isArray(tools) ? tools.map((tool) => tool.name).filter((name) => typeof name === "string") : [];
    } catch {
      return [];
    }
  };

  const apply = (cwd: string, add: string[]): { changed: boolean; next: string[] | null; error?: string } => {
    const config = configFor(cwd);
    const next = projectActiveSet(config, registered(), [...extras, ...add]);
    if (!next) return { changed: false, next: null };
    let current: string[] = [];
    try {
      current = pi.getActiveTools();
    } catch {
      current = [];
    }
    // cdcdf2d9 A2: v1 forced alphabetic order for an already-correct set.
    // Real startup finished in a different order; the fallback sorted AFTER
    // continuity froze event.systemPrompt, causing another human2 miss.
    // The runtime's final startup order is valid: do not mutate it just to sort.
    if (Array.isArray(current) && sameSet(current, next)) {
      return { changed: false, next: current };
    }
    try {
      pi.setActiveTools(next);
      extras = next.filter((name) => name !== META_TOOL && !config!.base.includes(name));
      return { changed: true, next };
    } catch (err) {
      return { changed: false, next: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const tool = {
    name: META_TOOL,
    label: "Activar herramientas",
    description: describeHerramientas(null),
    // Objeto schema plano: registerTool sólo exige un objeto. Sin depender de
    // @sinclair/typebox, que este package no instala y node --test no resuelve.
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        grupo: { type: "string", description: "Nombre de un grupo del catálogo" },
        nombres: {
          type: "array",
          items: { type: "string" },
          description: "Tools del catálogo, por nombre",
        },
      },
    },
    async execute(_id: string, params: { grupo?: string; nombres?: string[] }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const config = configFor(cwd);
      tool.description = describeHerramientas(config);
      const classified = classifyRequest(config, registered(), params.grupo, params.nombres);
      if (!config || !classified.ok) {
        return {
          content: [{ type: "text" as const, text: classified.motivo }],
          details: { changed: false, ...classified },
        };
      }
      ensureRegistered();
      const result = apply(cwd, classified.accepted);
      const text = result.error
        ? `no cambió el set (${result.error}). Sigue el set anterior.`
        : result.changed
          ? `activé para el próximo request: ${result.next!.join(", ")}`
          : `el set ya era ese: ${(result.next ?? []).join(", ")}`;
      const ignored = [
        classified.unknown.length ? `no registradas: ${classified.unknown.join(", ")}` : "",
        classified.fueraDeCatalogo.length ? `fuera de catálogo: ${classified.fueraDeCatalogo.join(", ")}` : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text" as const, text: ignored.length ? `${text}. ${ignored.join(". ")}` : text }],
        details: { changed: result.changed, next: result.next, error: result.error ?? null, ...classified },
      };
    },
  };

  const reconcile = (ctx: ExtensionContext) => {
    const config = configFor(ctx.cwd);
    tool.description = describeHerramientas(config);
    // Sin config válida la tool no se registra: pi, al refrescar, mete en el
    // set activo toda tool nueva del registry. No registrarla deja el arranque
    // igual que sin esta extensión. Si ya estaba, se saca sólo ella.
    if (!config) {
      try {
        const current = pi.getActiveTools();
        if (Array.isArray(current) && current.includes(META_TOOL)) {
          pi.setActiveTools(current.filter((name) => name !== META_TOOL));
        }
      } catch {
        /* el set anterior sigue; la garantía principal es no haberla registrado */
      }
      return;
    }
    ensureRegistered();
    apply(ctx.cwd, []);
  };

  // cdcdf2d9: reconcile BEFORE the first before_agent_start prompt snapshot.
  // A setActiveTools() inside that event rebuilds the live prompt, but a previous
  // handler may already have frozen event.systemPrompt (continuity). That caused
  // a one-human-turn delay after reload: schemas unchanged, <tools>/<rules> changed.
  // session_start runs after registration/resume, and before the human snapshot.
  pi.on("session_start", (_event, ctx) => reconcile(ctx));
  // Keep the fallback for late registration/config edits and standalone callers.
  pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));

  return { extras: () => extras.slice() };
}

export default function (pi: ExtensionAPI) {
  attachHerramientas(pi as unknown as HerramientasPi);
}
