// MIT. Agent Memory Access; see README for identity and exposure limits.
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

import { isAmaMode, readCerebroMode, readCerebroPerfil, withCerebroSurface, type CerebroMode, type CerebroPerfil } from "../lib/cerebro-surface.ts";

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

export function attachHerramientas(pi: HerramientasPi, mode: CerebroMode = readCerebroMode(process.cwd()), perfil: CerebroPerfil = readCerebroPerfil(process.cwd())): { extras: () => string[] } {
  let extras: string[] = [];
  let registeredTool = false;


  const universo = (): string[] | null => {
    try {
      const tools = pi.getAllTools();
      if (!Array.isArray(tools)) return null;
      return tools
        .filter((tool) => typeof tool.name === "string" && (
          tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only" ||
          (isAmaMode(mode) && tool.exposure === "codemode" && (tool.name === "codemode" || tool.name.startsWith("cb_")))
        ))
        .map((tool) => tool.name);
    } catch {
      return null;
    }
  };
  const configFor = (cwd: string): HerramientasConfig | null => {
    const raw = readConfig(cwd);
    const universe = universo();
    const config = withCerebroSurface(resolverInicial(raw, universe), universe ?? [], mode, perfil);




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



    if (!config) {
      try {
        const current = pi.getActiveTools();
        if (Array.isArray(current) && current.includes(META_TOOL)) {
          pi.setActiveTools(current.filter((name) => name !== META_TOOL));
        }
      } catch {

      }
      return;
    }
    ensureRegistered();
    apply(ctx.cwd, []);
  };






  pi.on("session_start", (_event, ctx) => reconcile(ctx));

  pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));

  return { extras: () => extras.slice() };
}

export default function (pi: ExtensionAPI) {
  attachHerramientas(pi as unknown as HerramientasPi);
}
