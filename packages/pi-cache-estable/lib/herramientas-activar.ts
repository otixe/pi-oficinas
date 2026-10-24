// Lista base por cuerpo y activación explícita. Puro: no llama a pi.
// Fail-safe: sin config válida, o sin ninguna tool de la base registrada,
// no hay set que aplicar (el caller no llama a setActiveTools).
// Con config, el set proyectado siempre incluye la base registrada.
// Nunca se activa un nombre que no esté en el catálogo (base ∪ grupos).

export const META_TOOL = "herramientas_activar";

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const GROUP_NAME = /^[a-z][a-z0-9_-]{0,40}$/;

export interface Grupo {
  linea: string;
  tools: string[];
}

export interface HerramientasConfig {
  base: string[];
  grupos: Record<string, Grupo>;
  /**
   * F4 (a82e464f): `"base": "*"` = the base is the tool universe of the body (registered with
   * direct exposure; pi already limits it with --tools from the profile) minus the group tools.
   * It is made concrete with resolverInicial().
   */
  inicial?: true;
}

/** Base marker: «what was active at startup, minus the groups». */
export const BASE_INICIAL = "*";

export function dedupe(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function parseHerramientasConfig(raw: unknown): HerramientasConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "base" && k !== "grupos")) return null;
  const inicial = o.base === BASE_INICIAL;
  if (!inicial) {
    if (!Array.isArray(o.base) || o.base.length === 0) return null;
    if (o.base.some((n) => typeof n !== "string" || !TOOL_NAME.test(n))) return null;
  }
  if (!o.grupos || typeof o.grupos !== "object" || Array.isArray(o.grupos)) return null;
  const grupos: Record<string, Grupo> = {};
  for (const [name, value] of Object.entries(o.grupos as Record<string, unknown>)) {
    if (!GROUP_NAME.test(name)) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const g = value as Record<string, unknown>;
    if (Object.keys(g).some((k) => k !== "linea" && k !== "tools")) return null;
    if (typeof g.linea !== "string" || g.linea.trim().length === 0 || g.linea.length > 120 || g.linea.includes("\n")) return null;
    if (!Array.isArray(g.tools) || g.tools.length === 0) return null;
    if (g.tools.some((n) => typeof n !== "string" || !TOOL_NAME.test(n))) return null;
    grupos[name] = { linea: g.linea.trim(), tools: dedupe(g.tools as string[]) };
  }
  if (inicial) return { base: [], grupos, inicial: true };
  return { base: dedupe(o.base as string[]), grupos };
}

/**
 * F4: makes a `"base": "*"` config concrete against the body's universe (direct registry,
 * already limited by --tools).
 * - base = universe − META − group tools;
 * - each group keeps only universe tools (it never adds anything new: catalog ⊆ universe ⊆
 *   --tools of the profile);
 * - empty groups are dropped; with an empty base there is nothing to apply (null).
 * An explicit config (base as a list) is returned unchanged.
 */
export function resolverInicial(config: HerramientasConfig | null, universo: string[] | null): HerramientasConfig | null {
  if (!config || !config.inicial) return config;
  if (!universo) return null;
  const inicial = dedupe(universo.filter((name) => name !== META_TOOL));
  const enInicial = new Set(inicial);
  const grupos: Record<string, Grupo> = {};
  const enGrupos = new Set<string>();
  for (const [name, grupo] of Object.entries(config.grupos)) {
    const tools = grupo.tools.filter((tool) => enInicial.has(tool));
    if (tools.length === 0) continue;
    grupos[name] = { linea: grupo.linea, tools };
    for (const tool of tools) enGrupos.add(tool);
  }
  const base = inicial.filter((name) => !enGrupos.has(name));
  if (base.length === 0) return null;
  return { base, grupos };
}

/** Tools a demanda: las de los grupos (no se esperan activas hasta que se pidan). */
export function toolsAdemanda(config: HerramientasConfig | null): Set<string> {
  const out = new Set<string>();
  if (!config) return out;
  for (const grupo of Object.values(config.grupos)) for (const tool of grupo.tools) out.add(tool);
  return out;
}

export function loadHerramientasConfig(text: string | null | undefined): HerramientasConfig | null {
  if (text == null) return null;
  try {
    return parseHerramientasConfig(JSON.parse(text));
  } catch {
    return null;
  }
}

export function catalogOf(config: HerramientasConfig): Set<string> {
  const names = new Set<string>(config.base);
  for (const grupo of Object.values(config.grupos)) {
    for (const tool of grupo.tools) names.add(tool);
  }
  return names;
}

/** Una línea por grupo. No incluye schemas. */
export function catalogLines(config: HerramientasConfig): string[] {
  return Object.entries(config.grupos).map(([name, grupo]) => `- ${name}: ${grupo.linea}`);
}

export function describeHerramientas(config: HerramientasConfig | null): string {
  if (!config) {
    return "Sin .pi/herramientas.json válido: esta llamada no activa ni quita tools.";
  }
  const lines = catalogLines(config);
  return [
    "Activa tools ya registradas para el próximo request del modelo. La base queda siempre. Si esta llamada falla, el set no cambia.",
    lines.length > 0 ? `Grupos:\n${lines.join("\n")}` : "No hay grupos; la base sigue activa.",
  ].join("\n");
}

/**
 * Set a aplicar. null = no llamar a setActiveTools.
 * Incluye siempre la base que esté registrada. extras sólo si están en el catálogo y registradas.
 * META_TOOL entra sólo si está registrada (la extensión la registra antes).
 */
export function projectActiveSet(
  config: HerramientasConfig | null,
  registered: string[],
  extras: string[],
): string[] | null {
  if (!config) return null;
  const reg = new Set(registered);
  const base = config.base.filter((name) => reg.has(name));
  if (base.length === 0) return null;
  const catalog = catalogOf(config);
  const extra = extras.filter((name) => reg.has(name) && catalog.has(name) && !base.includes(name));
  const meta = reg.has(META_TOOL) ? [META_TOOL] : [];
  return dedupe([...base, ...extra, ...meta]);
}

export interface ClassifiedRequest {
  ok: boolean;
  motivo: string;
  grupoDesconocido: string | null;
  accepted: string[];
  unknown: string[];
  fueraDeCatalogo: string[];
}

export function classifyRequest(
  config: HerramientasConfig | null,
  registered: string[],
  grupo?: string,
  nombres?: string[],
): ClassifiedRequest {
  const empty = {
    ok: false,
    motivo: "",
    grupoDesconocido: null as string | null,
    accepted: [] as string[],
    unknown: [] as string[],
    fueraDeCatalogo: [] as string[],
  };
  if (!config) return { ...empty, motivo: "sin config válida; no cambio el set" };
  const pedido = nombres ?? [];
  if (!grupo && pedido.length === 0) return { ...empty, motivo: "nada pedido; no cambio el set" };
  if (grupo && !Object.prototype.hasOwnProperty.call(config.grupos, grupo)) {
    return { ...empty, motivo: `grupo desconocido: ${grupo}; no cambio el set`, grupoDesconocido: grupo };
  }
  const catalog = catalogOf(config);
  const reg = new Set(registered);
  const requested = dedupe([...(grupo ? config.grupos[grupo].tools : []), ...pedido]);
  const fueraDeCatalogo = requested.filter((name) => !catalog.has(name));
  const inCatalog = requested.filter((name) => catalog.has(name));
  const unknown = inCatalog.filter((name) => !reg.has(name));
  const accepted = inCatalog.filter((name) => reg.has(name));
  if (accepted.length === 0) {
    return {
      ok: false,
      motivo: "ningún nombre aceptado; no cambio el set",
      grupoDesconocido: null,
      accepted,
      unknown,
      fueraDeCatalogo,
    };
  }
  return { ok: true, motivo: "ok", grupoDesconocido: null, accepted, unknown, fueraDeCatalogo };
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((name) => sb.has(name));
}
