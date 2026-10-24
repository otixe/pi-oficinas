import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type MonitorPaneState='working'|'idle'|'done'|'missing'|'unknown';
export interface PaneObservation {state:MonitorPaneState; pane?:Record<string,any>; sessionFile?:string; sessionId?:string; registrySession?:string; sessionMismatch?:boolean}
export interface SessionActivity {mtimeMs:number; size:number; stopReason:string|null; stopClass:'error'|'length'|'aborted'|'other'|'unknown'}
export interface BackgroundState {running:number|null; readable:boolean}

export function parsePaneObservation(raw:unknown,paneId:string,registrySession?:string):PaneObservation {
  if(!raw||typeof raw!=='object')return {state:'unknown'};
  const root=raw as any;
  if(root?.error?.code==='pane_not_found'&&!root?.result)return {state:'missing'};
  const pane=root?.result?.pane??root?.pane??root;
  if(!pane||typeof pane!=='object'||pane.pane_id!==paneId)return {state:'unknown'};
  const rawStatus=typeof pane.agent_status==='string'?pane.agent_status:pane.agent_status?.status;
  const state:MonitorPaneState=rawStatus==='working'||rawStatus==='busy'?'working':rawStatus==='idle'?'idle':rawStatus==='done'?'done':'unknown';
  const active=pane.agent_session?.kind==='path'&&typeof pane.agent_session?.value==='string'?pane.agent_session.value:undefined;
  const sessionFile=active&&isAbsoluteFile(active)?active:undefined;
  const fileId=sessionFile?basename(sessionFile).replace(/\.(?:jsonl|json)$/i,''):undefined;
  const inferredSessionId=fileId?(/^(?:\d{8}_\d{6})_(.+)$/.exec(fileId)?.[1]??
    /(?:^|_)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(fileId)?.[1]??fileId):undefined;
  const sessionId=typeof pane.agent_session?.id==='string'?pane.agent_session.id:inferredSessionId;
  return {state,pane, ...(sessionFile?{sessionFile}:{}),...(sessionId?{sessionId}:{}),
    ...(typeof registrySession==='string'?{registrySession,sessionMismatch:!!sessionFile&&registrySession!==sessionFile}:{})};
}
const isAbsoluteFile=(path:string)=>path.startsWith('/')&&resolve(path)===path;
function safeSessionFile(path:string):boolean {
  if(!isAbsoluteFile(path))return false;
  try {
    let part=dirname(path);
    while(part!=='/'&&part!==dirname(part)){
      const st=lstatSync(part);if(!st.isDirectory()||st.isSymbolicLink()||(st.uid!==process.getuid?.()&&st.uid!==0))return false;
      part=dirname(part);
    }
    const root=lstatSync('/');if(!root.isDirectory()||root.isSymbolicLink())return false;
    const st=lstatSync(path);
    return st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.uid===process.getuid?.()||st.uid===0);
  } catch{return false;}
}
function stopClass(reason:string|null):SessionActivity['stopClass'] {
  if(!reason)return 'unknown';
  const normalized=reason.trim().toLowerCase();
  if(['error','errored','tool_error','api_error'].includes(normalized))return 'error';
  if(['length','max_tokens','max_output_tokens','model_context_window_exceeded'].includes(normalized))return 'length';
  if(['aborted','abort','interrupted','cancelled','canceled'].includes(normalized))return 'aborted';
  return 'other';
}
function assistantAndReason(row:any):{assistant:boolean;reason:string|null} {
  const message=row?.message;
  const isAssistant=message?.role==='assistant'||row?.role==='assistant'||row?.type==='assistant';
  if(!isAssistant)return {assistant:false,reason:null};
  const value=message?.stopReason??message?.stop_reason??row?.stopReason??row?.stop_reason??null;
  return {assistant:true,reason:typeof value==='string'?value:null};
}
/** Reads only the bounded tail; session transcripts may be hundreds of MB. */
export function readSessionActivity(path:string,tailBytes=64*1024):SessionActivity|null {
  if(!safeSessionFile(path)||!Number.isInteger(tailBytes)||tailBytes<1024||tailBytes>256*1024)return null;
  let fd:number|undefined;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=fstatSync(fd);
    if(!st.isFile()||st.nlink<1||(st.uid!==process.getuid?.()&&st.uid!==0))return null;
    const start=Math.max(0,st.size-tailBytes),length=st.size-start;
    const bytes=Buffer.alloc(length);let at=0;
    while(at<length){const n=readSync(fd,bytes,at,length-at,start+at);if(n<=0)break;at+=n;}
    const text=bytes.subarray(0,at).toString('utf8');
    let latest:string|null=null;
    for(const line of text.split(/\r?\n/).reverse()){
      if(!line.trim())continue;
      try{const row=JSON.parse(line);const result=assistantAndReason(row);if(result.assistant){latest=result.reason;break;}}catch{/* partial first line at bounded window */}
    }
    return {mtimeMs:st.mtimeMs,size:st.size,stopReason:latest,stopClass:stopClass(latest)};
  }catch{return null;}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}
function safeJson(path:string,maxBytes=32*1024):any|null {
  try {
    const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>maxBytes||(st.uid!==process.getuid?.()&&st.uid!==0))return null;
    return JSON.parse(readFileSync(path,'utf8'));
  }catch{return null;}
}
/** No task body is loaded; only bounded JSON state files from this session bucket. */
export function readBackgroundTasks(body:string,sessionId:string|undefined):BackgroundState {
  if(!sessionId||!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId))return {running:null,readable:false};
  const root=join(body,'.pi','tasks',sessionId);
  try {
    const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())return {running:0,readable:true};
    const names=readdirSync(root).filter(name=>name.endsWith('.json')).slice(0,100);
    let running=0;
    for(const name of names){const state=safeJson(join(root,name));if(!state)continue;
      const value=String(state.status??state.state??state.phase??'').toLowerCase();
      if(state.running===true||['running','in_progress','working','active','started'].includes(value))running++;
    }
    return {running,readable:true};
  }catch(e:any){return e?.code==='ENOENT'?{running:0,readable:true}:{running:null,readable:false};}
}

export type MonitorVerdict='TRABAJANDO'|'LIBRE'|'ESPERANDO'|'PARADA'|'PEGADA'|'CORTADA'|'CAÍDA'|'DESCONOCIDO';
export interface VerdictInput {pane:MonitorPaneState;hasActiveTask:boolean;hasBlockedTask?:boolean;hasSubmittedTask?:boolean;backgroundRunning?:number|null;writeAgeMinutes?:number|null;stopClass?:SessionActivity['stopClass']|string}
export function monitorVerdict(input:VerdictInput,pegadaMin=20,paradaMin=10):MonitorVerdict {
  if(input.pane==='missing')return 'CAÍDA';
  if(input.hasBlockedTask||input.hasSubmittedTask||(input.backgroundRunning??0)>0)return 'ESPERANDO';
  if(input.pane==='unknown')return 'DESCONOCIDO';
  if((input.pane==='idle'||input.pane==='done')&&input.writeAgeMinutes!==null&&input.writeAgeMinutes!==undefined&&input.writeAgeMinutes<paradaMin)
    return 'TRABAJANDO';
  if(input.hasActiveTask){
    if(input.backgroundRunning===null)return 'DESCONOCIDO';
    if((input.pane==='idle'||input.pane==='done')&&(input.writeAgeMinutes===null||input.writeAgeMinutes===undefined))return 'DESCONOCIDO';
    if((input.pane==='idle'||input.pane==='done')&&['error','length','aborted'].includes(String(input.stopClass)))return 'CORTADA';
    if((input.pane==='idle'||input.pane==='done'))return 'PARADA';
    if(input.pane==='working'&&input.writeAgeMinutes!==null&&input.writeAgeMinutes!==undefined&&input.writeAgeMinutes>=pegadaMin)return 'PEGADA';
    return input.pane==='working'?'TRABAJANDO':'DESCONOCIDO';
  }
  if(input.hasBlockedTask||input.hasSubmittedTask)return 'ESPERANDO';
  if(input.backgroundRunning===null)return 'DESCONOCIDO';
  return input.pane==='working'?'TRABAJANDO':'LIBRE';
}

export interface MonitorHealth {pane:MonitorPaneState;sessionFile?:string;sessionId?:string;sessionMismatch?:boolean;lastWriteAt?:number;writeAgeMinutes?:number;stopReason:string|null;stopClass:SessionActivity['stopClass'];backgroundRunning:number|null}
export function collectPaneHealth(observation:PaneObservation,body:string,now=Date.now()):MonitorHealth {
  const activity=observation.sessionFile?readSessionActivity(observation.sessionFile):null;
  const bg=readBackgroundTasks(body,observation.sessionId);
  return {pane:observation.state,...(observation.sessionFile?{sessionFile:observation.sessionFile}:{}),
    ...(observation.sessionId?{sessionId:observation.sessionId}:{}),...(observation.sessionMismatch!==undefined?{sessionMismatch:observation.sessionMismatch}:{}),
    ...(activity?{lastWriteAt:activity.mtimeMs,writeAgeMinutes:Math.max(0,(now-activity.mtimeMs)/60_000)}:{}),
    stopReason:activity?.stopReason??null,stopClass:activity?.stopClass??'unknown',backgroundRunning:bg.readable?bg.running:null};
}

export function contextAge(now:number,observedAt:number):number|null {
  return Number.isFinite(now)&&Number.isFinite(observedAt)&&observedAt<=now?Math.max(0,now-observedAt):null;
}
