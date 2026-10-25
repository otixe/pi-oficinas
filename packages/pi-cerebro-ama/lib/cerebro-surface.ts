// MIT. Agent Memory Access; see README for identity and exposure limits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dedupe, loadHerramientasConfig, type HerramientasConfig } from "./herramientas-activar.ts";

export const CEREBRO_CORE = [
  "cb_whoami", "cb_correspondencia_resumen", "cb_task_get", "cb_task_comment",
  "cb_task_submit", "cb_vault_read", "cb_memory_add", "cb_memory_search",
] as const;
// Six most-used non-core permitted tools from a seven-day leader call census.
export const CEREBRO_CORE_LIDER = [
  ...CEREBRO_CORE, "cb_task_activity", "cb_correspondencia_leer", "cb_task_create",
  "cb_correspondencia_ok", "cb_task_update", "cb_task_review",
] as const;
// Known leader/admin-only routes; profile is not an authorization grant.
export const CEREBRO_LIDER_ADMIN = [
  "cb_agent_list", "cb_agent_provision", "cb_agent_revoke", "cb_leader_provision",
  "cb_consolidation_analyze", "cb_retrieval_eval_run", "cb_skill_mine",
  "cb_approval_approve", "cb_approval_request_changes", "cb_approval_revoke",
] as const;
export type CerebroMode = "traditional" | "ama" | "code";
export type CerebroPerfil = "lider" | "subagente";
export function isAmaMode(mode: CerebroMode): boolean {
  return mode === "ama" || mode === "code";
}
export function cerebroCore(perfil: CerebroPerfil = "subagente"): readonly string[] {
  return perfil === "lider" ? CEREBRO_CORE_LIDER : CEREBRO_CORE;
}
export function cerebroProfileAllows(name: string, perfil: CerebroPerfil): boolean {
  return perfil === "lider" || !CEREBRO_LIDER_ADMIN.includes(name as typeof CEREBRO_LIDER_ADMIN[number]);
}
export function readCerebroSurface(cwd: string): { mode: CerebroMode; perfil: CerebroPerfil } {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".pi", "cerebro-surface.json"), "utf8"));
    const catalog = loadHerramientasConfig(readFileSync(join(cwd, ".pi", "herramientas.json"), "utf8"));
    if (raw && !Array.isArray(raw) && Object.keys(raw).every(k => k === "mode" || k === "perfil")
        && (raw.mode === "ama" || raw.mode === "code") && catalog
        && (raw.perfil === undefined || raw.perfil === "lider" || raw.perfil === "subagente")) {
      return { mode: "ama", perfil: raw.perfil ?? "subagente" };
    }
  } catch { /* Invalid/missing flags and catalogs preserve traditional behavior. */ }
  return { mode: "traditional", perfil: "subagente" };
}
export function readCerebroMode(cwd: string): CerebroMode {
  return readCerebroSurface(cwd).mode;
}
export function readCerebroPerfil(cwd: string): CerebroPerfil {
  return readCerebroSurface(cwd).perfil;
}
export function cerebroExposure(mode: CerebroMode, name: string, perfil: CerebroPerfil = "subagente"): "direct" | "codemode" | "hidden" {
  if (!isAmaMode(mode) || !name.startsWith("cb_")) return "direct";
  if (!cerebroProfileAllows(name, perfil)) return "hidden";
  return cerebroCore(perfil).includes(name) ? "direct" : "codemode";
}
export function withCerebroSurface(config: HerramientasConfig | null, universe: string[], mode: CerebroMode, perfil: CerebroPerfil = "subagente"): HerramientasConfig | null {
  if (!config || !isAmaMode(mode) || !universe.includes("codemode")) return config;
  const core = new Set<string>(cerebroCore(perfil));
  const optional = universe.filter(name => name.startsWith("cb_") && !core.has(name) && cerebroProfileAllows(name, perfil));
  const groups: HerramientasConfig["grupos"] = {};
  for (const [name, group] of Object.entries(config.grupos)) {
    const tools = group.tools.filter(tool => !tool.startsWith("cb_") && tool !== "codemode");
    if (tools.length) groups[name] = { ...group, tools };
  }
  const prior = groups.cerebro?.tools ?? [];
  if (optional.length || prior.length) groups.cerebro = {
    linea: "Cerebro opcional: codemode o activación directa por nombre/grupo",
    tools: dedupe([...prior, ...optional]),
  };
  return {
    base: dedupe([
      ...config.base.filter(name => !name.startsWith("cb_") && name !== "codemode"),
      ...universe.filter(name => core.has(name) && cerebroProfileAllows(name, perfil)), "codemode",
    ]),
    grupos: groups,
  };
}
