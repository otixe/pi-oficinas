import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendPrivateLine, rotateJsonlIfLarge } from './secretaria-state.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { teamConfig } from '../lib/team-config.ts';

// Presence is explicit: a name/key alone never makes the leader's body an office.
export function validPaneId(pane: unknown): pane is string {
  return typeof pane==='string' && /^[A-Za-z0-9:_-]+$/.test(pane);
}
export type PaneQuietState='working'|'idle'|'missing'|'unknown';
export interface PaneQuietObservation {state:PaneQuietState;paneId?:string}
export function observePaneQuiet(pane: unknown,
  probe:(id:string)=>{status:number|null;stdout:string}=id=>spawnSync('herdr',['pane','get',id],{encoding:'utf8',timeout:5000})):PaneQuietObservation {
  if(!validPaneId(pane))return {state:'unknown'};
  try {
    const res=probe(pane),data=JSON.parse(res.stdout||'{}');
    if(res.status===1 && data?.error?.code==='pane_not_found' && !data.result)return {state:'missing',paneId:pane};
    const info=data?.result?.pane;
    if(res.status!==0 || !info || info.pane_id!==pane)return {state:'unknown',paneId:pane};
    const raw=typeof info.agent_status==='string'?info.agent_status:info.agent_status?.status;
    if(typeof raw!=='string'||!raw.trim()||['unknown','unavailable','indeterminate'].includes(raw.toLowerCase()))return {state:'unknown',paneId:pane};
    return {state:['working','busy'].includes(raw.toLowerCase())?'working':'idle',paneId:pane};
  }catch{return {state:'unknown',paneId:pane}}
}
export function paneConfirmedMissing(pane: unknown,
  probe: (id:string)=>{status:number|null;stdout:string}=id=>spawnSync('herdr',['pane','get',id],{encoding:'utf8',timeout:5000})): boolean {
  return observePaneQuiet(pane,probe).state==='missing';
}

export function isOfficeBody(cwd: string) {
  try { return readFileSync(join(cwd, '.pi', 'oficina-body'), 'utf8') === 'pi-oficinas-v1\n'; }
  catch { return false; }
}
export function deliveryMode(status: number): 'writer' | 'read-only' {
  // An impossible task id probes permission without claiming an existing task.
  return status === 404 ? 'writer' : 'read-only';
}
export type Bell = {at: string; direction: string; task_id: string; target?: string; status: string; error?: string};
export function logBell(file: string, entry: Omit<Bell, 'at'>) {
  mkdirSync(dirname(file), {recursive: true});
  appendFileSync(file, JSON.stringify({at: new Date().toISOString(), ...entry}) + '\n');
}
export function orderReadyTasks<T extends {id:string;priority?:string;created_at?:string}>(tasks:T[]):T[] {
  const rank:Record<string,number>={high:0,medium:1,low:2};
  return [...tasks].sort((a,b)=>(rank[a.priority ?? ''] ?? 3)-(rank[b.priority ?? ''] ?? 3) ||
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id));
}
export function unseenIds(file: string, tasks: {id: string; status: string; assignee: string; tags?: string[]}[], owner: string, deliver?: (id: string) => void) {
  let seen: string[] = [];
  try { seen = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) {
    if (existsSync(file)) throw e; // corrupted state is not an invitation to re-inject
  }
  const fresh = tasks.filter(t => t.status === 'todo' && t.assignee === owner && t.tags?.includes('oficina') && !seen.includes(t.id)).slice(0, 1).map(t => t.id);
  if (fresh.length) {
    deliver?.(fresh[0]); // only persist after successful delivery
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, JSON.stringify([...new Set([...seen, ...fresh])]) + '\n');
  }
  return fresh;
}
export async function taggedCandidates(items: any[], owner: string, detail: (id: string) => Promise<any>) {
  const tagged = [];
  for (const candidate of items) {
    if (!candidate?.id || candidate.status !== 'todo' || candidate.assignee !== owner) continue;
    const task = await detail(candidate.id); // list payload intentionally has no tags
    if (task.id === candidate.id && task.status === 'todo' && task.assignee === owner &&
        Array.isArray(task.tags) && task.tags.includes('oficina')) tagged.push(task);
  }
  return tagged;
}
export function ownerDelivery(events: {kind:string; agent:string; body:string}[], owner:string, body:string) {
  return body.startsWith(`ENTREGA·${owner}\n`) &&
    events.some(e => e.kind === 'comment' && e.agent === owner && e.body === body);
}
export interface TaskAvailabilityTransition {kind:'review'|'handoff'|'todo'|'unblock';at?:string}
/** Latest custody/status fact that makes an office task actionable; later claims/reviews supersede it. */
export function taskAvailabilityTransition(events: unknown): TaskAvailabilityTransition | null {
  if (!Array.isArray(events)) return null;
  const latest = events.filter(e => e && typeof e === 'object' && (e.to_status != null || e.kind === 'handoff')).at(-1);
  if (!latest) return null;
  if (latest.kind === 'review' && latest.from_status === 'submitted' && latest.to_status === 'in_progress' &&
      typeof latest.body === 'string' && /^needs_changes:/i.test(latest.body))
    return {kind:'review', ...(typeof latest.created_at === 'string' ? {at:latest.created_at} : {})};
  if (latest.kind === 'handoff')
    return {kind:'handoff', ...(typeof latest.created_at === 'string' ? {at:latest.created_at} : {})};
  if (latest.kind === 'unblock' && latest.to_status === 'in_progress')
    return {kind:'unblock', ...(typeof latest.created_at === 'string' ? {at:latest.created_at} : {})};
  if (latest.to_status === 'todo')
    return {kind:'todo', ...(typeof latest.created_at === 'string' ? {at:latest.created_at} : {})};
  return null;
}
export function returnedForChanges(events: unknown): boolean {
  if (!Array.isArray(events)) return false;
  const review = events.filter(e => e && typeof e === 'object' && e.kind === 'review').at(-1);
  const available = taskAvailabilityTransition(events);
  return !!review && review.from_status === 'submitted' && review.to_status === 'in_progress' &&
    typeof review.body === 'string' && /^needs_changes:/i.test(review.body) &&
    (available?.kind === 'review' || available?.kind === 'handoff');
}
/** 2362a4e2: the task is back IN the owner's hands because its LATEST status transition is an unblock to in_progress. */
export function unblockedLatest(events: unknown): {at: string} | null {
  if (!Array.isArray(events)) return null;
  const latest = events.filter(e => e && typeof e === 'object' && e.to_status != null).at(-1);
  return latest?.kind === 'unblock' && latest.to_status === 'in_progress' && typeof latest.created_at === 'string'
    ? {at: latest.created_at} : null;
}
export function questionId(office: string, taskId: string, question: string): string {
  return createHash('sha256').update(JSON.stringify([office,taskId,question.trim()])).digest('hex').slice(0,16);
}
export function persistBellRetry(queueFile: string, notice: LeaderNotice, status: string): number {
  const retryFile=queueFile+'.retry';
  let previous=0;
  if(existsSync(retryFile)) {
    for(const line of readFileSync(retryFile,'utf8').split('\n').filter(Boolean)) {
      const row=JSON.parse(line);
      if(row.fingerprint===notice.fingerprint && Number.isInteger(row.attempt)) previous=Math.max(previous,row.attempt);
    }
  }
  const attempt=previous+1;
  // F5 (a82e464f): estado local acotado y sin texto libre. El texto del timbre ya vive en la cola;
  // acá sólo ids/estados. 0600 aunque el archivo existiera más abierto; rota al pasar 1 MB.
  rotateJsonlIfLarge(retryFile);
  appendPrivateLine(retryFile,{fingerprint:notice.fingerprint,attempt,status,task_id:notice.task_id,kind:notice.kind,
    direction:notice.direction??'vuelta',...(notice.target?{target:notice.target}:{}),at:new Date().toISOString()});
  return attempt;
}
export interface TaskEvent {kind?:string;agent?:string;body?:string;created_at?:string;from_status?:string;to_status?:string}
export function questionState(events: TaskEvent[], leader=teamConfig().lider): {questions: Map<string,TaskEvent>; responses: Set<string>} {
  const questions=new Map<string,TaskEvent>(), responses=new Set<string>();
  for (const e of events) {
    if (e.kind!=='comment' || typeof e.body!=='string') continue;
    const q=/^PREGUNTA·([a-z][a-z0-9-]{0,39})·([a-f0-9]{16})(?:\n|$)/.exec(e.body);
    if (q && e.agent===q[1]) questions.set(q[2],e);
    const a=new RegExp(`^RESPUESTA·${leader}·([a-f0-9]{16})(?:\\n|$)`).exec(e.body);
    if (a && e.agent===leader) responses.add(a[1]);
  }
  return {questions,responses};
}
export function blockType(reason: unknown): string {
  const type=typeof reason==='string'?reason.trim().split(/[:\s]/,1)[0].toLowerCase():'';
  return ['dependency','external','info','resource'].includes(type)?type:'otro';
}
export interface LeaderNotice {kind:'question'|'block'|'delivery'|'quiet'|'dependency'|'response'|'task-available'|'health-reentry'|'health-alert'|'correspondence-received'|'correspondence-timeout'|'correspondence-reservation-uncertain'|'correspondence-batch';task_id:string;fingerprint:string;text:string;expected?:Record<string,unknown>;direction?:'ida'|'vuelta';target?:string;paneState?:PaneQuietState}
const priority: Record<LeaderNotice['kind'],number>={question:0,response:0,'health-alert':0,'correspondence-reservation-uncertain':0,block:1,dependency:1,'task-available':2,'health-reentry':2,'correspondence-received':0,'correspondence-timeout':1,'correspondence-batch':2,quiet:3,delivery:4};
export function leaderNoticePriority(notice: Pick<LeaderNotice,'kind'|'expected'>): number {
  if(notice.kind==='correspondence-received') {
    const value=notice.expected?.priority;
    if(value==='urgente')return 0;
    if(value==='medio')return 2;
    if(value==='bajo')return 4;
    return 2;
  }
  return priority[notice.kind];
}
export function orderLeaderNotices(items: LeaderNotice[]): LeaderNotice[] {
  return [...items].sort((a,b)=>leaderNoticePriority(a)-leaderNoticePriority(b) || a.fingerprint.localeCompare(b.fingerprint));
}
export function leaderAlerts(task: {id:string;status:string;assignee:string;blocked_reason?:string}, events:TaskEvent[],
  now: number, quietAfterMs=30*60_000,paneState?:PaneQuietState,lastSessionWriteAt?:number): LeaderNotice[] {
  const notices:LeaderNotice[]=[];
  const {questions,responses}=questionState(events);
  for (const [id,e] of questions) if (!responses.has(id)) notices.push({kind:'question',task_id:task.id,
    fingerprint:`question:${task.id}:${id}`,text:`Pregunta pendiente en ${task.id} — leela en el tablero`});
  if(task.status==='blocked') {
    const last=[...events].reverse().find(e=>e.kind==='block' && e.to_status==='blocked');
    notices.push({kind:'block',task_id:task.id,fingerprint:`block:${task.id}:${last?.created_at ?? task.blocked_reason ?? 'unknown'}`,
      text:`Oficina ${task.assignee} bloqueada en ${task.id}: ${blockType(task.blocked_reason)} — leela en el tablero`});
  }
  if(task.status==='in_progress') {
    const last=events.at(-1)?.created_at;
    const since=last?Date.parse(last):NaN;
    const latestActivity=Math.max(Number.isFinite(since)?since:0,Number.isFinite(lastSessionWriteAt)?lastSessionWriteAt!:0);
    if(latestActivity>0 && now-latestActivity>quietAfterMs && paneState && paneState!=='working'){
      const text=paneState==='unknown'
        ?`Estado de oficina desconocido ${task.assignee} en ${task.id} — leela en el tablero`
        :`Oficina callada ${task.assignee} en ${task.id} — leela en el tablero${paneState==='missing'?'; pane inexistente confirmado: sugerencia bin/oficina levantar':''}`;
      notices.push({kind:'quiet',task_id:task.id,paneState,
        fingerprint:`quiet:${task.id}:${last}:${paneState}`,text});
    }
  }
  return orderLeaderNotices(notices);
}
export type OfficeNotice = {kind:'task-available'|'response'|'dependency';taskId:string;questionId?:string;status?:string;pendingDependencies?:number;pendingDependencyId?:string;pendingQuestionId?:string};
export function parseOfficeNotice(text: string): OfficeNotice | null {
  if(typeof text!=='string'||text.length>500)return null;
  const id='([A-Za-z0-9:_-]{1,64})';
  let m=new RegExp(`^🔔 Tenés la tarea ${id} — leela en el tablero$`).exec(text);
  if(m)return {kind:'task-available',taskId:m[1]};
  m=new RegExp(`^🔔 respuesta disponible en ${id} pregunta ([a-f0-9]{16}); sigue bloqueada: dependencia ${id} no done \\(([1-9][0-9]*) pendientes\\) — leela en el tablero$`).exec(text);
  if(m)return {kind:'response',taskId:m[1],questionId:m[2],status:'blocked',pendingDependencyId:m[3],pendingDependencies:Number(m[4])};
  m=new RegExp(`^🔔 respuesta disponible en ${id} pregunta ([a-f0-9]{16}); sigue bloqueada: pregunta abierta ([a-f0-9]{16}) — leela en el tablero$`).exec(text);
  if(m)return {kind:'response',taskId:m[1],questionId:m[2],status:'blocked',pendingQuestionId:m[3],pendingDependencies:0};
  m=new RegExp(`^🔔 respuesta disponible en ${id} pregunta ([a-f0-9]{16}); sigue bloqueada por ([1-9][0-9]*) dependencias — leela en el tablero$`).exec(text);
  if(m)return {kind:'response',taskId:m[1],questionId:m[2],status:'blocked',pendingDependencies:Number(m[3])};
  m=new RegExp(`^🔔 ${teamConfig().lider} respondió ${id} pregunta ([a-f0-9]{16}) — leela en el tablero(?: \\(estado: (todo|in_progress)\\))?$`).exec(text);
  if(m)return {kind:'response',taskId:m[1],questionId:m[2],...(m[3]?{status:m[3]}:{})};
  m=new RegExp(`^🔔 Dependencia resuelta en ${id} — leela en el tablero$`).exec(text);
  if(m)return {kind:'dependency',taskId:m[1]};
  return null;
}
export type LeaderParsedNotice={kind:'question'|'block'|'delivery'|'dependency'|'quiet';taskId:string;office?:string;status?:string;blockKind?:string;paneState?:PaneQuietState}|{kind:'correspondence';taskId:string;codes:string[]};
export function parseLeaderNotice(text:string):LeaderParsedNotice|null {
  if(typeof text!=='string'||text.length>500)return null;
  const id='([A-Za-z0-9:_-]{1,64})';
  const dep='([a-z][a-z0-9-]{0,39})';
  let m=new RegExp(`^🔔 ${dep} preguntó en ${id} — leela en el tablero \\(estado: (todo|in_progress|blocked)\\)$`).exec(text);
  if(m)return {kind:'question',office:m[1],taskId:m[2],status:m[3]};
  m=new RegExp(`^🔔 ${dep} bloqueó ${id}: (dependency|external|info|resource|otro) — leela en el tablero$`).exec(text);
  if(m)return {kind:'block',office:m[1],taskId:m[2],blockKind:m[3]};
  m=new RegExp(`^🔔 ${dep} entregó la tarea ${id} — leela en el tablero$`).exec(text);
  if(m)return {kind:'delivery',office:m[1],taskId:m[2]};
  m=new RegExp(`^Dependencia lista para ${dep} en ${id} — leela en el tablero$`).exec(text);
  if(m)return {kind:'dependency',office:m[1],taskId:m[2]};
  m=new RegExp(`^Oficina callada ${dep} en ${id} — leela en el tablero(; pane inexistente confirmado: sugerencia bin/oficina levantar)?$`).exec(text);
  if(m)return {kind:'quiet',office:m[1],taskId:m[2],paneState:m[3]?'missing':'idle'};
  m=new RegExp(`^Estado de oficina desconocido ${dep} en ${id} — leela en el tablero(?:; sin pane registrado: revisión supervisada)?$`).exec(text);
  if(m)return {kind:'quiet',office:m[1],taskId:m[2],paneState:'unknown'};
  m=new RegExp(`^Pregunta pendiente en ${id} — leela en el tablero$`).exec(text);
  if(m)return {kind:'question',taskId:m[1]};
  m=new RegExp(`^Oficina ${dep} bloqueada en ${id}: (dependency|external|info|resource|otro) — leela en el tablero$`).exec(text);
  if(m)return {kind:'block',office:m[1],taskId:m[2],blockKind:m[3]};
  m=/^📨 Correspondencia de @([a-z][a-z0-9-]{0,39}(?:\/[a-z][a-z0-9-]{0,39})?) \(([A-Za-z0-9_-]{1,24})\) ([A-Za-z0-9._-]{1,64}) — leela con cb_correspondencia_leer$/.exec(text);
  if(m)return {kind:'correspondence',taskId:m[3],codes:[m[3]]};
  m=/^📨 Correspondencia nueva \(([1-9][0-9]{0,2})\): (.+) — leela con cb_correspondencia_leer$/.exec(text);
  if(m){const rows=m[2].split('; '),codes:string[]=[];
    for(const row of rows){const item=/^@[a-z][a-z0-9-]{0,39}(?:\/[a-z][a-z0-9-]{0,39})? \([A-Za-z0-9_-]{1,24}\) ([A-Za-z0-9._-]{1,64})$/.exec(row);if(!item)return null;codes.push(item[1]);}
    if(rows.length!==Number(m[1])||new Set(codes).size!==codes.length)return null;
    return {kind:'correspondence',taskId:codes[0],codes};}
  return null;
}
export function practitionerAllowed(type: unknown, owner: string) {
  return type === `mini-${owner}`;
}
export function lookupPane(registry: Record<string, any>, creator: string, leader=teamConfig().lider) {
  return creator === leader ? registry._creators?.[leader] : registry[creator]?.pane_id;
}
export function queueLeaderBell(queueFile: string, bellFile: string, notice: LeaderNotice | null, target: string | undefined,
  launch: typeof spawn = spawn, dispatch = true): void {
  if (notice) {
    if (!notice.expected || !['question','block','delivery','response','dependency','task-available','health-reentry','correspondence-received','correspondence-timeout','correspondence-reservation-uncertain','correspondence-batch'].includes(notice.kind)) throw new Error('Aviso sin predicado verificable; NO encolar');
    if (!target) {
      const attempt=persistBellRetry(queueFile,notice,'target_missing');
      logBell(bellFile,{direction:notice.direction||'ida',task_id:notice.task_id,status:`retry target_missing:${attempt}`});
      return;
    }
    mkdirSync(dirname(queueFile),{recursive:true});
    appendFileSync(queueFile,JSON.stringify({...notice,target})+'\n');
    if (!dispatch) return;
  } else if (!existsSync(queueFile)) return; // periodic drain, no new event
  // A single detached dispatcher owns this leader queue across office processes.
  // Sort every pending batch immediately BEFORE prompting, not before waiting
  // for an occupied pane: a question arriving during wait overtakes a delivery.
  const flowFile=join(dirname(fileURLToPath(import.meta.url)),'secretaria-flow.ts');
  const script=`const fs=require('node:fs');const cp=require('node:child_process');
const [queue,log,flow,identityFile]=process.argv.slice(1),lock=queue+'.lock',sent=queue+'.sent',retryFile=queue+'.retry';
let fd;try{fd=fs.openSync(lock,'wx',0o600)}catch(e){
if(e.code!=='EEXIST')throw e;
try{if(Date.now()-fs.statSync(lock).mtimeMs>720000){const trash=require('node:path').join(require('node:path').dirname(lock),'.trash');fs.mkdirSync(trash,{recursive:true});fs.renameSync(lock,require('node:path').join(trash,'leader-lock-stale-'+Date.now()));fd=fs.openSync(lock,'wx',0o600)}}catch(recovery){fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),direction:'vuelta',task_id:'',status:'fallido',error:'lock_recovery_failed'})+'\\n')}
if(fd===undefined)process.exit(0)
}
const done=new Set(),deferred=new Set(),retryCount=new Map();
if(fs.existsSync(retryFile))for(const line of fs.readFileSync(retryFile,'utf8').split('\\n'))if(line){const row=JSON.parse(line);if(typeof row.fingerprint==='string'&&Number.isInteger(row.attempt)&&row.attempt>0)retryCount.set(row.fingerprint,row.attempt)}
const logEvent=(n,status,error)=>fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),direction:n.direction||'vuelta',task_id:n.task_id,target:n.target,status,...(error?{error}: {})})+'\\n');
const retryEvent=(n,status,detail)=>{const attempt=(retryCount.get(n.fingerprint)||0)+1;retryCount.set(n.fingerprint,attempt);
fs.appendFileSync(retryFile,JSON.stringify({fingerprint:n.fingerprint,attempt,status})+'\\n',{mode:0o600});deferred.add(n.fingerprint);
logEvent(n,attempt>=3?'reintentos_agotados':'fallido',status+(detail?':'+detail:''));return attempt};
const herdrEnv={};for(const name of ['PATH','HOME','LANG'])if(process.env[name]!==undefined)herdrEnv[name]=process.env[name];
for(const [name,value] of Object.entries(process.env))if(name.startsWith('HERDR_')&&value!==undefined)herdrEnv[name]=value;
const exitCode=result=>Number.isInteger(result.status)&&result.status>=0&&result.status<=255?'exit_'+result.status:'unknown';
const read=()=>{if(fs.existsSync(sent))for(const id of fs.readFileSync(sent,'utf8').split('\\n'))if(id)done.add(id);
const lines=fs.readFileSync(queue,'utf8').split('\\n').filter(Boolean),items=new Map();
for(const line of lines){const n=JSON.parse(line);if(done.has(n.fingerprint)||deferred.has(n.fingerprint)||(retryCount.get(n.fingerprint)||0)>=3)continue;
if(n.kind==='correspondence-received'){
const legacy=/^📨 Correspondencia de @([a-z][a-z0-9-]{0,39}) \\((urgente|medio|bajo)\\) ([0-9a-f]{16}(?:\\.[1-9][0-9]*)?) — leela con cb_correspondencia_leer$/.exec(n.text);
const hasPriority=['urgente','medio','bajo'].includes(n.expected?.priority);
n.expected={...(n.expected||{}),leader:n.expected?.leader||team.lider,originalCode:n.expected?.originalCode||n.task_id,
 remitente:n.expected?.remitente||legacy?.[1],priority:hasPriority?n.expected.priority:(legacy?.[2]||'medio')};
if(n.expected.priority!=='urgente')continue; // Medio se informa en un lote; bajo no genera un timbre individual.
}
items.set(n.fingerprint,n)}
const rank=n=>n.kind==='correspondence-received'?({urgente:0,medio:2,bajo:4}[n.expected?.priority]??2):({question:0,response:0,block:1,dependency:1,'task-available':2,'health-reentry':2,'correspondence-timeout':1,'correspondence-reservation-uncertain':0,'correspondence-batch':2,delivery:4}[n.kind]??3);
return [...items.values()].sort((a,b)=>rank(a)-rank(b)||a.fingerprint.localeCompare(b.fingerprint))};
const cwd=process.cwd();
const {pathToFileURL}=require('node:url');
const loadTs=async file=>import(pathToFileURL(file).href);
(async()=>{try{
const {parseEnvFile,resolveIdentityFrom,AUTH_HEADER,teamConfig}=await loadTs(identityFile);
const team=teamConfig();
const env=parseEnvFile(cwd);
const marker=require('node:path').join(cwd,'.pi','oficina-body');
const markerPresent=fs.existsSync(marker);let isOffice=false;
if(markerPresent)try{isOffice=fs.readFileSync(marker,'utf8')==='pi-oficinas-v1\\n'}catch{}
const who=isOffice?String(env.AGENT_NAME||'').toLowerCase():team.lider;
const key=((markerPresent&&!isOffice)||(isOffice&&(!team.oficinas.includes(who)||cwd!==require('node:path').join(team.base,who)))||(!isOffice&&cwd!==team.lider_body))?'':resolveIdentityFrom(isOffice?who:null,env,process.env).key;
const base=process.env.CEREBRO_BASE||env.CEREBRO_BASE||'';
const auth=AUTH_HEADER;let lookupFailed=false,rootTaskId='';
const cerebroClientFile=require('node:path').join(require('node:path').dirname(flow),'secretaria-cerebro-client.ts');
const {fetchCerebro}=await loadTs(cerebroClientFile);
const api={get:async path=>{try{if(!key)throw Error('sin key propia para validar timbre');const res=await fetchCerebro(base,path,{headers:{[auth]:key}},15000);
const data=await res.json();const queryId=path.startsWith('/task/get?')?new URL(path,'http://local').searchParams.get('task_id'):null;
if((path.startsWith('/task/get?')&&(!data?.id||typeof data.status!=='string'||(queryId===rootTaskId&&typeof data.assignee!=='string')))||(path.startsWith('/task/activity?')&&(!Array.isArray(data?.events)||data.events.some(e=>typeof e?.kind!=='string'||typeof e?.agent!=='string')))||(path.startsWith('/task/deps?')&&!Array.isArray(data?.blocked_by)))throw Error('GET ambiguo');return data}catch(e){lookupFailed=true;throw e}},post:async()=>{throw Error('worker read-only')}};
let confirm;
const correspondenceFile=require('node:path').join(require('node:path').dirname(flow),'secretaria-correspondence.ts');
const reservationFile=require('node:path').join(require('node:path').dirname(flow),'secretaria-correspondence-reservation.ts');
const leaderRegistryFile=require('node:path').join(require('node:path').dirname(flow),'secretaria-leader-registry.ts');
const stateDirectory=require('node:path').join(team.lider_body,'state');
const resolveLeaders=async()=>{const {resolveLeaderNames}=await loadTs(leaderRegistryFile);
 const fetchRegistry=async()=>{const res=await fetchCerebro(base,'/agents/registry',{headers:{[auth]:key}},30000);return res.json()};
 return resolveLeaderNames(stateDirectory,fetchRegistry)};
const verify=async n=>{
 if(n.kind==='correspondence-received'){
  lookupFailed=false;
  try{const {correspondenceItems,originalStillUnread,formatIncomingBell,leaderRegistryCandidate}=await loadTs(correspondenceFile);
   const expected=n.expected||{};
   if(expected.leader!==team.lider||typeof expected.originalCode!=='string'||typeof expected.remitente!=='string'||!['urgente','medio','bajo'].includes(expected.priority))return {ok:false,lookupFailed:false};
   const raw=await api.get('/correspondencia/bandeja?archivo=false&incluir_contenido=false');
   const rows=correspondenceItems(raw);
   if(!rows){lookupFailed=true;return {ok:false,lookupFailed}}
   const sender=leaderRegistryCandidate(expected.remitente,team.lider);
   const registryResolution=await resolveLeaders();
   if(registryResolution.fetchError)fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),direction:'correspondencia',task_id:'',
     status:registryResolution.source==='last-good'?'registro de l\u00edderes fresco fall\u00f3; usando \u00faltimo-bueno':'registro de l\u00edderes fresco fall\u00f3',
     error:registryResolution.fetchError})+'\\n');
   const leaders=registryResolution.leaders;
   if(!leaders){lookupFailed=true;return {ok:false,lookupFailed}}
   if(!sender||!leaders.has(sender))return {ok:false,lookupFailed:false};
   const original=rows.find(row=>row.codigo===expected.originalCode);
   if(!original||!originalStillUnread(raw,team.lider,expected.originalCode,expected.remitente)||original.prioridad!==expected.priority)return {ok:false,lookupFailed:false};
   n.text=formatIncomingBell(original);
   return {ok:true,lookupFailed:false};
  }catch{return {ok:false,lookupFailed:true}}
 }
 if(n.kind==='correspondence-timeout'){
  lookupFailed=false;
  try{const {correspondenceItems,destinationHasAcknowledged,formatSenderTimeout}=await loadTs(correspondenceFile);
   const x=n.expected||{},sentAt=Date.parse(x.sentAt||'');
   if(x.leader!==team.lider||typeof x.noticeCode!=='string'||typeof x.original!=='string'||typeof x.destination!=='string'||
      !Number.isInteger(x.minutes)||!Number.isFinite(sentAt)||Date.now()-sentAt<x.minutes*60000)return {ok:false,lookupFailed:false};
   const rows=correspondenceItems(await api.get('/correspondencia/bandeja?archivo=false&incluir_contenido=false'));
   if(!rows){lookupFailed=true;return {ok:false,lookupFailed}}
   const notice=rows.find(row=>row.codigo===x.noticeCode),ack=notice?destinationHasAcknowledged(notice,x.destination):null;
   if(ack===null)return {ok:false,lookupFailed:false};
   if(ack===true)return {ok:false,lookupFailed:false};
   n.text=formatSenderTimeout(x.destination,x.original,x.minutes);return {ok:true,lookupFailed:false};
  }catch{return {ok:false,lookupFailed:true}}
 }
 if(n.kind==='correspondence-reservation-uncertain'){
  lookupFailed=false;
  try{
   const x=n.expected||{},reservationModule=await loadTs(reservationFile);
   const unreadableReasons=[reservationModule.RESERVATION_IDENTITY_TIMEOUT_REASON,reservationModule.RESERVATION_RECOVERY_IDENTITY_TIMEOUT_REASON];
   if(x.leader!==team.lider||typeof x.original!=='string'||! /^[0-9a-f]{16}(?:\.[1-9][0-9]*)?$/.test(x.original)||
      typeof x.destination!=='string'||! /^[A-Za-z0-9_-]{1,40}$/.test(x.destination)||
      !unreadableReasons.includes(String(x.reason))||
      !Number.isInteger(x.confirmMin)||Number(x.confirmMin)<1)return {ok:false,lookupFailed:false};
   const path=require('node:path').join(team.lider_body,'state','secretaria-correspondence-v2.jsonl');
   let raw;try{raw=fs.readFileSync(path,'utf8')}catch(error){if(error?.code==='ENOENT')return {ok:false,lookupFailed:false};throw error;}
   const rows=raw.split('\\n').filter(Boolean).map(line=>JSON.parse(line));
   const exists=rows.some(row=>row.kind==='notice_uncertain'&&row.original===x.original&&row.destination===x.destination&&row.reason===x.reason);
   if(!exists)return {ok:false,lookupFailed:false};
   n.text='Reserva de Correspondencia '+x.original+' para @'+x.destination+' sin identidad de proceso verificable tras '+(Number(x.confirmMin)*3)+' min; el envío es incierto y no se reintenta a ciegas. Revisión requerida.';
   return {ok:true,lookupFailed:false};
  }catch{return {ok:false,lookupFailed:true}}
 }
 if(n.kind==='health-reentry'){
  lookupFailed=false;rootTaskId=n.task_id;
  try{const task=await api.get('/task/get?task_id='+encodeURIComponent(n.task_id));
   return {ok:task.id===n.task_id&&task.status==='in_progress'&&task.assignee===n.expected?.office&&task.claimed_by===n.expected?.office,lookupFailed:false};
  }catch{return {ok:false,lookupFailed:true}}
 }
 if(n.kind==='correspondence-batch'){
  // El texto ya se armo en el momento del encolado con datos frescos del ledger (277eb7cf);
  // aca solo re-verificamos identidad del lider y forma -- nunca reconstruye el texto a ciegas.
  lookupFailed=false;
  const x=n.expected||{};
  const ok=x.leader===team.lider&&Array.isArray(x.codes)&&x.codes.length>0&&
    x.codes.every(code=>typeof code==='string'&&/^[0-9a-f]{16}(?:\.[1-9][0-9]*)?$/.test(code));
  return {ok,lookupFailed:false};
 }
 if(!confirm){confirm=(await loadTs(flow)).confirmarEfecto}
 lookupFailed=false;rootTaskId=n.task_id;const ok=await confirm(api,n.kind,n.task_id,n.expected);return {ok,lookupFailed}
};
// Head-of-line fix (2362a4e2): ONE busy pane never holds the others. Every round visits the pending targets in the
// order of their best notice and gives each a SHORT wait; a busy target (herdr «timeout») is skipped and revisited,
// re-read and that target's best notice goes first. Any other wait error fails only that target, for this drain.
const WAIT_SLICE_MS=1500;
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
let idle=0;while(idle<3){let pending=read();if(!pending.length){idle++;sleep(250);continue}idle=0;let busyRound=false;
try{const now=new Date();fs.utimesSync(lock,now,now)}catch{} // a long drain is alive: keep the lock fresh
let progressed=false;
for(const target of [...new Set(pending.map(x=>x.target))]){
const wait=cp.spawnSync('herdr',['agent','wait',target,'--until','idle','--until','done','--timeout',String(WAIT_SLICE_MS)],{encoding:'utf8',timeout:WAIT_SLICE_MS+15000,env:herdrEnv});
if(wait.status!==0){
 const busy=/"code"\\s*:\\s*"timeout"/.test(String(wait.stderr||''));
 if(busy){busyRound=true;logEvent(pending.find(x=>x.target===target)||{direction:'vuelta',task_id:'',target},'pane ocupado; aviso sigue en cola');}

 if(!busy){
  for(const x of read().filter(x=>x.target===target))retryEvent(x,'wait_fallido',exitCode(wait));
 }
 continue}
pending=read();const n=pending.find(x=>x.target===target);if(!n)continue; // its best notice, re-read after the wait
progressed=true;
const outcome=await verify(n);
if(outcome.lookupFailed){retryEvent(n,'lookup_failed','No se pudo confirmar efecto actual; queda pendiente');continue}
if(!outcome.ok){fs.appendFileSync(sent,n.fingerprint+'\\n');done.add(n.fingerprint);logEvent(n,'descartado','Efecto ya no vigente');continue}
const reply=cp.spawnSync('herdr',['agent','prompt',n.target,n.text],{encoding:'utf8',timeout:15000,env:herdrEnv});
if(reply.status!==0){retryEvent(n,'prompt_failed',exitCode(reply));continue}
fs.appendFileSync(sent,n.fingerprint+'\\n');done.add(n.fingerprint);logEvent(n,'enviado');
break} // one delivery per round: re-read so a higher-priority notice of any free target goes next
if(!progressed){if(busyRound)break;sleep(250)}
}}catch(e){try{for(const n of read())retryEvent(n,'worker_error')}catch{}fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),direction:'vuelta',task_id:'',status:'fallido',error:'worker_error'})+'\\n')}
finally{fs.closeSync(fd);fs.unlinkSync(lock)}})();`;
  const identityFile=join(dirname(fileURLToPath(import.meta.url)),'..','lib','cerebro-identity.ts');
  const failLaunch=(status:string)=>{
    const sent=new Set(existsSync(queueFile+'.sent')?readFileSync(queueFile+'.sent','utf8').split('\n').filter(Boolean):[]);
    const pending:LeaderNotice[]=[];
    if(notice)pending.push(notice);
    else if(existsSync(queueFile))try{for(const line of readFileSync(queueFile,'utf8').split('\n').filter(Boolean)){
      const row=JSON.parse(line) as LeaderNotice;if(!sent.has(row.fingerprint))pending.push(row);
    }}catch{}
    for(const item of pending)try{persistBellRetry(queueFile,item,status)}catch{}
    logBell(bellFile,{direction:notice?.direction||'ida',task_id:notice?.task_id ?? '',status:`retry ${status}`});
  };
  try {
    const child=launch(process.execPath,['--experimental-strip-types','-e',script,queueFile,bellFile,flowFile,identityFile],{detached:true,stdio:'ignore'});
    child.on('error',()=>failLaunch('child_error'));
    child.unref();
  } catch {failLaunch('child_error')}
}

export function ring(file: string, taskId: string, target: string | undefined, direction: string, text: string,
  launch: typeof spawn = spawn) {
  if (!target) { logBell(file, {direction, task_id: taskId, status: 'sin timbre de vuelta'}); return; }
  logBell(file, {direction, task_id: taskId, target, status: 'pendiente'});
  const script = `const {spawnSync}=require('node:child_process');const fs=require('node:fs');
const [file,task,target,direction,text]=process.argv.slice(1);
const log=(status,error)=>fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),direction,task_id:task,target,status,...(error?{error}: {})})+'\\n');
const herdrEnv={};for(const name of ['PATH','HOME','LANG'])if(process.env[name]!==undefined)herdrEnv[name]=process.env[name];
for(const [name,value] of Object.entries(process.env))if(name.startsWith('HERDR_')&&value!==undefined)herdrEnv[name]=value;
const exitCode=result=>Number.isInteger(result.status)&&result.status>=0&&result.status<=255?'exit_'+result.status:'unknown';
const wait=spawnSync('herdr',['agent','wait',target,'--until','idle','--until','done','--timeout','600000'],{encoding:'utf8',timeout:605000,env:herdrEnv});
if(wait.status!==0){log('fallido','wait_fallido:'+exitCode(wait));process.exit(0)}
const sent=spawnSync('herdr',['agent','prompt',target,text],{encoding:'utf8',timeout:15000,env:herdrEnv});
log(sent.status===0?'enviado':'fallido',sent.status===0?undefined:'prompt_fallido:'+exitCode(sent));`;
  try {
    const child = launch(process.execPath, ['-e', script, file, taskId, target, direction, text], {detached:true, stdio:'ignore'});
    child.on('error', () => logBell(file, {direction, task_id:taskId, target, status:'fallido', error:'child_error'}));
    child.unref();
  } catch { logBell(file, {direction, task_id:taskId, target, status:'fallido', error:'child_error'}); }
}
