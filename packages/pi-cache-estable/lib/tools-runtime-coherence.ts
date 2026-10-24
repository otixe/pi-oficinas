// Adaptada de upstream HEAD:.pi/lib/tools-runtime-coherence.ts.
// Sólo contrasta herramientas DECLARADAS en una profile con getActiveTools().
// No valida permisos, no decide autorización ni infiere herramientas omitidas.
import { readFileSync } from "node:fs";
import { META_TOOL, catalogOf, loadHerramientasConfig, toolsAdemanda, type HerramientasConfig } from "./herramientas-activar.ts";
import { join } from "node:path";


export type Verdict = "coherente" | "faltan" | "sin-declaracion" | "inventario-vacio" | "catalogo-deriva";
export interface ToolCensus {
  agent: string | null;
  declaredPath: string | null;
  declared: string[] | null;
  received: string[];
  missing: string[];
  extra: string[];
  verdict: Verdict;
  phase: "before_agent_start";
}

/** Parser mínimo para las dos formas de `tools:` que usa pi-subagents.
 * null significa no declarado; [] significa declaración explícita `none`. */
export function parseDeclaredTools(md: string): string[] | null {
  const lines = md.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return null;
  const line = lines.slice(1, end).find((entry) => /^tools:[ \t]*/.test(entry));
  if (line === undefined) return null;
  let raw = line.replace(/^tools:[ \t]*/, "").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const tools = raw.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return tools.length === 1 && tools[0] === "none" ? [] : tools;
}

/** Resuelve identidad con el MISMO resolvedor que cb_*; no se reutiliza la
 * identidad upstream ni se deriva una credencial a partir del nombre de profile. */
export function censusAgent(prompt: string, env: Record<string, string>, penv: Record<string, string | undefined>): string | null {
  const candidates = [env.AGENT_NAME, penv.PI_AGENT_NAME, penv.AGENT_NAME,
    ...[...prompt.matchAll(/<(?:office_agent|active_agent)\b[^>]*name=["']([A-Za-z0-9_-]+)["']/g)].map(m=>m[1])].filter(Boolean);
  const names = new Set(candidates);
  return names.size === 1 ? [...names][0]! : null; // diagnostic identity only, never authentication
}

export function buildCensus(input: {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  penv: Record<string, string | undefined>;
  received: string[];
}): ToolCensus {
  const received = [...new Set(input.received)].sort();
  const agent = censusAgent(input.prompt, input.env, input.penv);
  const base = { agent, received, phase: "before_agent_start" as const };
  // Una identidad ambigua o un nombre inesperado jamás se convierte en ruta.
  if (!agent || !/^[a-zA-Z0-9_-]+$/.test(agent)) {
    return { ...base, declaredPath: null, declared: null, missing: [], extra: [], verdict: "sin-declaracion" };
  }
  const declaredPath = join(".pi", "agents", `${agent}.md`);
  let declared: string[] | null = null;
  try {
    declared = parseDeclaredTools(readFileSync(join(input.cwd, declaredPath), "utf8"));
  } catch {
    // Agente sin profile local: no afirmar coherencia ni ausencia.
  }
  if (declared === null) {
    return { ...base, declaredPath, declared, missing: [], extra: [], verdict: "sin-declaracion" };
  }
  if (declared.length > 0 && received.length === 0) {
    return { ...base, declaredPath, declared, missing: [], extra: [], verdict: "inventario-vacio" };
  }
  // F4 (a82e464f): herramientas a demanda. Las tools de los grupos de .pi/herramientas.json
  // están declaradas pero se activan al pedirlas: no son «faltan». La meta-tool no es «extra».
  // Un catálogo EXPLÍCITO (base como lista) con tools fuera de la profile es deriva y se avisa.
  let herramientas: HerramientasConfig | null = null;
  try { herramientas = loadHerramientasConfig(readFileSync(join(input.cwd, ".pi", "herramientas.json"), "utf8")); } catch { herramientas = null; }
  const declaredSet = new Set(declared);
  if (herramientas && !herramientas.inicial) {
    const fuera = [...catalogOf(herramientas)].filter((t) => !declaredSet.has(t)).sort();
    if (fuera.length) return { ...base, declaredPath, declared, missing: [], extra: fuera, verdict: "catalogo-deriva" };
  }
  const aDemanda = toolsAdemanda(herramientas);
  const have = new Set(received);
  const promised = new Set(declared);
  if (herramientas) promised.add(META_TOOL);
  const missing = declared.filter((t) => !have.has(t) && !aDemanda.has(t)).sort();
  const extra = received.filter((t) => !promised.has(t)).sort();
  return { ...base, declaredPath, declared, missing, extra, verdict: missing.length ? "faltan" : "coherente" };
}

/** Un aviso es observación, jamás autorización. `extra` es informativo: tools
 * inyectadas por pi o packages no necesariamente figuran en la profile. */
export function renderCoherenceDiagnostic(c: ToolCensus): string | null {
  if (c.verdict === "sin-declaracion") return null;
  if (c.verdict === "inventario-vacio") {
    return `⚠️ NO PUDE CONCLUIR: ${c.declaredPath} promete ${c.declared?.length ?? 0} tools, pero getActiveTools() devolvió [] en before_agent_start. No se afirma que falten: verificá por invocación.`;
  }
  if (c.verdict === "catalogo-deriva") {
    return `⚠️ HERRAMIENTAS FUERA DE FICHA: .pi/herramientas.json tiene en su catálogo ${c.extra.join(", ")}, que ${c.declaredPath} no declara. Base ∪ grupos tiene que estar dentro de las tools de la profile.`;
  }
  if (c.verdict === "coherente") return null; // cero ruido en sesión sana
  return `⚠️ FICHA↔RUNTIME: ${c.declaredPath} declara tools no recibidas: ${c.missing.join(", ")}. Es una incapacidad medida, NO un guardarraíl ni una autorización. Reportá el faltante.`;
}
