// MIT. Agent Memory Access; see README for identity and exposure limits.
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "node:url";
import { teamConfig, officeKeyEnv } from './team-config.ts';
export { teamConfig } from './team-config.ts';















































































































































































const localTeamConfig = join(dirname(fileURLToPath(import.meta.url)), '..', 'equipo.json');

function optionalTeam(env: Record<string,string>, penv: Record<string,string|undefined>, legacyAnchorForTest?:string) {
  const explicit = Boolean(env.PI_OFICINAS_EQUIPO || penv.PI_OFICINAS_EQUIPO || process.env.PI_OFICINAS_EQUIPO || parseEnvFile(process.cwd()).PI_OFICINAS_EQUIPO);
  if (!explicit && !existsSync(localTeamConfig)) return null;
  return teamConfig(); // invalid/missing team fails closed, never falls back to agent identity
}
const bootEnv = parseEnvFile(process.cwd());

const configuredHeader = process.env.CEREBRO_AUTH_HEADER || bootEnv.CEREBRO_AUTH_HEADER || "X-API-Key";
export const AUTH_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(configuredHeader) ? configuredHeader : "invalid-auth-header";
let bootTeam: ReturnType<typeof teamConfig> | null = null;
try { bootTeam = optionalTeam(bootEnv, process.env); } catch { /* resolution still rejects invalid config */ }
export const LEADER = bootTeam?.lider || (bootEnv.AGENT_NAME || process.env.AGENT_NAME || "agent").toLowerCase();


export const AMBIGUOUS_OWNER = "identidad-ambigua";








export const IDENTITY_BUILD = "2026-08-04-6c47914c-r1-bootstrap-credencial-unificada";

export interface Identity {
  key: string;
  owner: string;
  isSubagent: boolean;
  varName: string;
}






export function parseEnvFile(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      let v = trimmed.slice(eq + 1).trim();
      if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, "").trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[trimmed.slice(0, eq).trim()] = v;
    }
  } catch {

  }
  return out;
}





export function hasAgentTag(prompt: string): boolean {
  return /<active_agent\b/i.test(prompt);
}







export function hasSubAgentContextTag(prompt: string): boolean {
  return /<sub_agent_context\b/i.test(prompt);
}








export function hasAgentInstructionsTag(prompt: string): boolean {
  return /<agent_instructions\b/i.test(prompt);
}
















export function hasSubagentShape(prompt: string): boolean {
  return hasAgentTag(prompt) || hasSubAgentContextTag(prompt) || hasAgentInstructionsTag(prompt);
}



















export function safeSubagentShapeSignal(getSystemPrompt: () => string): boolean {
  let prompt: string;
  try {
    prompt = getSystemPrompt();
  } catch {




    return true;
  }




  if (!prompt) return true;
  return hasSubagentShape(prompt);
}











export function resolveAgentNameFromPrompt(prompt: string): string | null {
  const re = /<active_agent\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const matches = [...prompt.matchAll(re)];
  if (matches.length === 0) return null;
  const names = matches.map((m) => (m[1] ?? m[2] ?? "").trim().toLowerCase());
  if (new Set(names.filter(Boolean)).size > 1) return null;
  return names[names.length - 1] || null;
}

















export function resolveIdentityFrom(
  agent: string | null,
  env: Record<string, string>,
  penv: Record<string, string | undefined>,
  hasSubagentShapeSignal = false,
  legacyAnchorForTest?: string,
): Identity {
  const config = optionalTeam(env, penv, legacyAnchorForTest);
  const officeBody = env.BODY_ROLE === 'office';


  if (env.AGENT_ENABLED === '0' || (!env.AGENT_ENABLED && penv.AGENT_ENABLED === '0')) {
    return {key:'', owner:agent || env.AGENT_NAME || config?.lider || 'agent',
      isSubagent:Boolean(agent || hasSubagentShapeSignal || officeBody), varName:'(scaffold inerte)'};
  }
  if (agent) {
    if (config) {


      const own = env.AGENT_NAME;



      if (env.MINI_PROPIO_MISMA_KEY === '1' && agent === `mini-${own}`) {
        const parent = officeBody && config.oficinas.includes(own) ? own :
          env.BODY_ROLE === 'leader' && own === config.lider ? config.lider : null;
        const varName = parent === config.lider ? config.lider_key_env :
          parent ? officeKeyEnv(config,parent) : null;
        if (!parent || !varName || (env.AGENT_KEY_ENV && env.AGENT_KEY_ENV !== varName))
          return {key:'',owner:agent,isSubagent:true,varName:'(mini propio inválido)'};
        return {key:penv[varName] || env[varName] || '',owner:parent,isSubagent:true,varName};
      }
      if (officeBody && agent !== own) return {key:'',owner:agent,isSubagent:true,varName:'(oficina ajena)'};



      if (!officeBody && agent === `mini-${config.lider}` && env.MINI_LIDER_MISMA_KEY === '1') {
        const leaderKey = config.lider_key_env;
        return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:true,varName:leaderKey};
      }


      if (!officeBody && !hasSubagentShapeSignal && agent === config.lider) {
        
        const leaderKey=config.lider_key_env;
        return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:false,varName:leaderKey};
      }
      const varName = config.oficinas.includes(agent) ? officeKeyEnv(config,agent) : '(oficina ajena)';
      return {key:varName==='(oficina ajena)'?'':penv[varName] || env[varName] || '',
        owner:agent,isSubagent:true,varName};
    }
    const configured = `${(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toUpperCase().replace(/-/g, '_')}_KEY_${agent.toUpperCase().replace(/-/g, '_')}`;
    const varName = /^[A-Z][A-Z0-9_]*$/.test(configured) ? configured : '(indeterminada)';
    return {key:penv[varName] || env[varName] || '',owner:agent,isSubagent:true,varName};
  }
  if (hasSubagentShapeSignal) {
    return {key:'',owner:AMBIGUOUS_OWNER,isSubagent:true,varName:'(indeterminada)'};
  }
  if (config) {
    if (officeBody) {
      const owner=env.AGENT_NAME;
      const expected=owner && config.oficinas.includes(owner) ? officeKeyEnv(config,owner) : null;
      if (!expected || (env.AGENT_KEY_ENV && env.AGENT_KEY_ENV !== expected))
        return {key:'',owner:owner || AMBIGUOUS_OWNER,isSubagent:true,varName:'(oficina ajena)'};
      return {key:penv[expected] || env[expected] || '',owner,isSubagent:true,varName:expected};
    }

    const leaderKey=config.lider_key_env;
    return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:false,varName:leaderKey};
  }
  if (officeBody) return {key:'',owner:AMBIGUOUS_OWNER,isSubagent:true,varName:'(sin config de equipo)'};
  const configured=env.AGENT_KEY_ENV || penv.AGENT_KEY_ENV ||
    `${(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toUpperCase().replace(/-/g, '_')}_KEY`;
  return {key:/^[A-Z][A-Z0-9_]*$/.test(configured)?(penv[configured] || env[configured] || ''):'',
    owner:(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toLowerCase(),isSubagent:false,varName:configured};
}








export function explainIdentityFailure(id: Identity): string {
  if (id.owner === AMBIGUOUS_OWNER) {
    return (
      `IDENTIDAD AMBIGUA: el system prompt tiene FORMA de subagente (<active_agent>, ` +
      `<sub_agent_context> y/o <agent_instructions>), o directamente no se pudo LEER el ` +
      `system prompt, o aparecen nombres distintos en conflicto: NO uso la key ` +
      `del líder ni la de una agente citada. Sos un subagente y no sé cuál ` +
      `(o no puedo confirmar que no lo seas), así que no escribiré en el ` +
      `Cerebro con una identidad falsa. Causas probables: (a) cambió el ` +
      `formato del tag <active_agent> en @gotgenes/pi-subagents, o directamente lo ` +
      `renombraron; (b) ctx.getSystemPrompt() lanzó o devolvió vacío (p.ej. sesión stale ` +
      `tras un reload/fork) — ver safeSubagentShapeSignal en .pi/lib/cerebro-identity.ts, ` +
      `tarea 6c47914c hallazgo H1. Revisá resolveAgentNameFromPrompt y hasSubagentShape.`
    );
  }
  if (id.isSubagent) {
    return (
      `No hay key propia para el subagente "${id.owner}" (falta ${id.varName} en .env). ` +
      `NO se usa la key del líder: eso falsearía la atribución en el Cerebro. ` +
      `Provisionala con agent_provision y agregala al .env.`
    );
  }
  return `No hay key de auth para el líder "${id.owner}". Revisá .env.`;
}
