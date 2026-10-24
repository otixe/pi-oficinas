import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type Usage = {input:number;output:number;cacheRead:number;cacheWrite:number};
type Stamp = {at:number;usage:Usage};
type State = {session:string;start:Stamp;claims:Record<string,Stamp>;reported:string[]};
const filename=(cwd:string)=>join(cwd,'state','secretaria-cost.json');
function session(ctx:ExtensionContext){return ctx.sessionManager.getSessionFile() || '';}
function usage(ctx:ExtensionContext):Usage {
  const sum:Usage={input:0,output:0,cacheRead:0,cacheWrite:0};
  for(const entry of ctx.sessionManager.getBranch()) {
    if(entry.type!=='message' || entry.message.role!=='assistant')continue;
    for(const key of Object.keys(sum) as (keyof Usage)[]){
      const amount=entry.message.usage?.[key];
      if(typeof amount==='number' && Number.isFinite(amount) && amount>=0)sum[key]+=amount;
    }
  }
  return sum;
}
function read(cwd:string):State|undefined {
  const path=filename(cwd);
  if(!existsSync(path))return;
  if(!lstatSync(path).isFile())throw Error('Estado costo no regular');
  const state=JSON.parse(readFileSync(path,'utf8'));
  if(typeof state?.session!=='string' || !state?.start || !state?.claims || !Array.isArray(state?.reported))throw Error('Estado costo corrupto');
  return state;
}
function save(cwd:string,state:State){
  const path=filename(cwd);mkdirSync(join(cwd,'state'),{recursive:true});
  if(existsSync(path) && !lstatSync(path).isFile())throw Error('Estado costo no regular');
  writeFileSync(path,JSON.stringify(state)+'\n',{mode:0o600});chmodSync(path,0o600);
}
export function startCostSession(ctx:ExtensionContext,cwd:string,now=Date.now()){
  const current=session(ctx);if(!current)return;
  const previous=read(cwd);
  if(previous?.session===current)return;
  save(cwd,{session:current,start:{at:now,usage:usage(ctx)},claims:{},reported:[]});
}
export function recordCostClaim(ctx:ExtensionContext,cwd:string,taskId:string,now=Date.now()){
  startCostSession(ctx,cwd,now);
  const state=read(cwd);if(!state || state.session!==session(ctx))return;
  state.claims[taskId]={at:now,usage:usage(ctx)};
  save(cwd,state);
}
export async function reportTaskCost(ctx:ExtensionContext,cwd:string,office:string,taskId:string,
  api:{get:(path:string)=>Promise<any>;post:(path:string,body:Record<string,unknown>)=>Promise<any>},now=Date.now()){
  startCostSession(ctx,cwd,now);
  const state=read(cwd);if(!state || state.session!==session(ctx) || state.reported.includes(taskId))return;
  const claim=state.claims[taskId];
  const text=claim?(()=>{
    const end=usage(ctx),start=claim.usage;
    const incoming=Math.max(0,end.input-start.input)+Math.max(0,end.cacheRead-start.cacheRead)+Math.max(0,end.cacheWrite-start.cacheWrite);
    const outgoing=Math.max(0,end.output-start.output);
    return `COSTO·${office}: ${incoming+outgoing} tokens (in ${incoming} / out ${outgoing}) · ${((now-claim.at)/60_000).toFixed(1)} min desde el claim`;
  })():`COSTO·${office}: no medible desde el relanzamiento (claim en otra sesión)`;
  // A retry after a successful POST but before the state write must not post twice.
  const activity=await api.get(`/task/activity?task_id=${encodeURIComponent(taskId)}`);
  if(!Array.isArray(activity.events))throw Error('Actividad costo no verificable');
  if(!activity.events.some((event:any)=>event.kind==='comment' && event.agent===office && event.body===text))
    await api.post('/task/comment',{task_id:taskId,body:text});
  state.reported.push(taskId);save(cwd,state);
}
