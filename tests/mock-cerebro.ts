import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {readFileSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import {parseEnvFile,resolveAgentNameFromPrompt,resolveIdentityFrom,safeSubagentShapeSignal} from '../packages/pi-oficinas/lib/cerebro-identity.ts';
/** TEST DOUBLE ONLY. Does not authenticate to a real service and must not be a production package. */
export default function(pi: ExtensionAPI) {
  if(process.env.PI_OFFICE_FIXTURE!=='1')throw Error('Explicit test-only opt-in required');
  const checked=(ctx:any)=>{
    const cwd=resolve(ctx.cwd), rel=relative(homedir(),cwd);
    if(!rel || rel.startsWith('..'))throw Error('Fixture outside isolated HOME');
    const env=parseEnvFile(cwd), id=resolveIdentityFrom(resolveAgentNameFromPrompt(ctx.getSystemPrompt()),env,process.env,safeSubagentShapeSignal(()=>ctx.getSystemPrompt()));
    if(id.owner!=='worker'||!id.isSubagent||!id.key||id.varName!=='TEAM_OFFICE_KEY_WORKER')throw Error('Fixture identity mismatch: '+JSON.stringify({owner:id.owner,varName:id.varName,isSubagent:id.isSubagent,keyPresent:Boolean(id.key),localAgent:env.AGENT_NAME,localRole:env.BODY_ROLE,shape:safeSubagentShapeSignal(()=>ctx.getSystemPrompt())}));
    return {cwd,id};
  };
  pi.registerTool({name:'cb_whoami',label:'Test-only identity',description:'Synthetic opening fixture; not real backend authentication',parameters:Type.Object({}),async execute(_id,_params,_signal,_update,ctx){
    const {id}=checked(ctx);
    return {content:[{type:'text',text:`identidad_resuelta : ${id.owner} (subagente)\norigen_de_la_key : ${id.varName}\ntools_cb : 2 (live)\nauth_verificada : TEST DOUBLE ONLY\n`}],details:{fixtureOnly:true}};
  }});
  pi.registerTool({name:'cb_vault_read',label:'Test-only vault',description:'Own neutral test SOUL only; not a real vault connection',parameters:Type.Object({path:Type.String()}),async execute(_id,params,_signal,_update,ctx){
    const {cwd}=checked(ctx);
    if(params.path!=='50 Agents/Example/Equipo/worker/Vigente/SOUL.md')throw Error('Foreign fixture SOUL');
    return {content:[{type:'text',text:readFileSync(join(cwd,'SOUL.md'),'utf8')}],details:{fixtureOnly:true}};
  }});
}
