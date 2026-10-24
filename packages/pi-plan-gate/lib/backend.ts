import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// Optional local configuration, not a source of credentials. Credentials are environment-only.
export function parseEnvFile(cwd: string): Record<string,string> {
  const values: Record<string,string> = {};
  try {
    for (const line of readFileSync(join(cwd,'.env'),'utf8').split(/\r?\n/)) {
      const match=/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      if (Object.hasOwn(values,match[1])) return {};
      let value=match[2];
      if (/^["']/.test(value)) { if(value.at(-1)!==value[0])return {}; value=value.slice(1,-1); }
      else value=value.replace(/\s+#.*$/,'').trim();
      values[match[1]]=value;
    }
  } catch { /* missing configuration is inactive */ }
  return values;
}
export const AUTH_HEADER = process.env.PLAN_GATE_AUTH_HEADER || 'X-API-Key';
export function resolveIdentity(ctx: ExtensionContext) {
  const local=parseEnvFile(ctx.cwd);
  const owner=process.env.PLAN_GATE_AGENT || local.PLAN_GATE_AGENT || '';
  const keyEnv=process.env.PLAN_GATE_KEY_ENV || local.PLAN_GATE_KEY_ENV || 'PLAN_GATE_KEY';
  let prompt = '';
  try { prompt = ctx.getSystemPrompt(); } catch { /* unknown identity remains blocked */ }
  const processAgent = process.env.PI_AGENT_NAME || process.env.AGENT_NAME;
  const isSubagent = !prompt?.trim() || process.env.BODY_ROLE==='office' ||
    (Boolean(processAgent) && processAgent !== owner) ||
    /<(?:sub_agent_context|active_agent|office_agent|agent_instructions)\b/i.test(prompt);
  const valid=/^[A-Za-z0-9_-]{1,128}$/.test(owner) && /^[A-Z_][A-Z0-9_]*$/.test(keyEnv);
  return {owner:valid?owner:'',key:valid?(process.env[keyEnv] || ''):'',isSubagent};
}
export async function backendFetch(url: string, method: string, headers: Record<string,string>, body?: unknown) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),3000);
  try {
    const response=await fetch(url,{method,headers,signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const bodyText=await response.text();
    if(bodyText.length>1_048_576)throw new Error('Backend response too large');
    return {status:response.status,bodyText};
  } finally {clearTimeout(timer);}
}
export function approver(): string { return (process.env.PLAN_GATE_APPROVER || 'human').toLowerCase(); }
export function readonlyAgents(): string[] {
  try {
    const names=JSON.parse(process.env.PLAN_GATE_READONLY_AGENTS || '[]');
    return Array.isArray(names)&&names.every(n=>typeof n==='string'&&/^[a-z0-9_-]+$/.test(n))?names:[];
  } catch {return [];}
}
