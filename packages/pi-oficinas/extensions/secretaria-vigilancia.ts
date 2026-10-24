export type HealthAction={kind:'reentry'|'leader';fingerprint:string;text:string;expected?:Record<string,unknown>};
export function healthTaskEligible(task:any,office:string):boolean {
  return !!task&&task.status==='in_progress'&&task.assignee===office&&task.claimed_by===office;
}
export interface TaskDetectorState {taskId:string;sessionMtime:number|null;idleSince:number|null;reentryAt:number|null;reentryMtime:number|null;escalatedMtime:number|null;cutMtime:number|null;stuckMtime:number|null}
export interface TaskDetectorInput {office:string;taskId:string;claimOwner:string|null;pane:'working'|'idle'|'done'|'missing'|'unknown';now:number;sessionMtime:number|null;writeAgeMinutes:number|null;stopClass:'error'|'length'|'aborted'|'other'|'unknown';backgroundRunning:number|null}
export interface DetectorThresholds {paradaMin:number;pegadaMin:number;cooldownMin:number;graceMin?:number}
const makeState=(taskId:string,mtime:number|null):TaskDetectorState=>({taskId,sessionMtime:mtime,idleSince:null,reentryAt:null,reentryMtime:null,escalatedMtime:null,cutMtime:null,stuckMtime:null});
export function detectTaskHealth(input:TaskDetectorInput,prior:TaskDetectorState|undefined,thresholds:DetectorThresholds):{state:TaskDetectorState;actions:HealthAction[]} {
  const state=prior?.taskId===input.taskId?{...prior}:makeState(input.taskId,input.sessionMtime);
  const sameSession=state.sessionMtime===input.sessionMtime;
  if(!sameSession){state.sessionMtime=input.sessionMtime;state.idleSince=null;state.reentryMtime=null;state.escalatedMtime=null;state.cutMtime=null;state.stuckMtime=null;}
  const actions:HealthAction[]=[];
  const owned=input.claimOwner===input.office;
  const canObserve=input.pane!=='unknown'&&input.pane!=='missing'&&input.backgroundRunning===0;
  const canReenter=()=>input.sessionMtime!==null&&state.reentryMtime!==input.sessionMtime&&
    (state.reentryAt===null||input.now-state.reentryAt>=thresholds.cooldownMin*60_000);
  const ring=()=>{
    if(!canReenter())return false;
    const fingerprint=`health-reentry:${input.taskId}:${input.sessionMtime}`;
    actions.push({kind:'reentry',fingerprint,expected:{office:input.office,sessionMtime:input.sessionMtime},
      text:`🔔 Tenés la tarea ${input.taskId} — leela en el tablero`});
    state.reentryAt=input.now;state.reentryMtime=input.sessionMtime;return true;
  };
  if(!owned||!canObserve||input.sessionMtime===null||input.writeAgeMinutes===null){
    state.idleSince=null;
    return {state,actions};
  }
  if(input.writeAgeMinutes<(thresholds.graceMin??5)){
    if(input.pane==='idle'||input.pane==='done')state.idleSince??=input.now;
    else state.idleSince=null;
    return {state,actions};
  }
  if((input.pane==='idle'||input.pane==='done')&&input.stopClass!=='other'&&input.stopClass!=='unknown'){
    if(state.cutMtime!==input.sessionMtime){
      state.cutMtime=input.sessionMtime;
      actions.push({kind:'leader',fingerprint:`cut:${input.taskId}:${input.sessionMtime}:${input.stopClass}`,
        text:`Turno cortado ${input.office} en ${input.taskId} (${input.stopClass}) — leela en el tablero`});
      ring();
    }
    state.idleSince??=input.now;
    return {state,actions};
  }
  if(input.pane==='working'){
    state.idleSince=null;
    if(input.writeAgeMinutes>=thresholds.pegadaMin&&state.stuckMtime!==input.sessionMtime){
      state.stuckMtime=input.sessionMtime;
      actions.push({kind:'leader',fingerprint:`stuck:${input.taskId}:${input.sessionMtime}`,
        text:`Oficina pegada ${input.office} en ${input.taskId} — leela en el tablero`});
    }
    return {state,actions};
  }
  if(input.pane==='idle'||input.pane==='done'){
    if(state.idleSince===null)state.idleSince=input.now;
    const writeAge=input.writeAgeMinutes*60_000;
    const continuous=Math.max(0,input.now-state.idleSince);
    if(writeAge>=thresholds.paradaMin*60_000&&continuous>=thresholds.paradaMin*60_000){
      ring();
      if(state.reentryAt!==null&&input.now-state.reentryAt>=thresholds.paradaMin*60_000&&state.escalatedMtime!==input.sessionMtime){
        state.escalatedMtime=input.sessionMtime;
        actions.push({kind:'leader',fingerprint:`stopped:${input.taskId}:${input.sessionMtime}`,
          text:`Oficina parada ${input.office} en ${input.taskId} — leela en el tablero`});
      }
    }
  }
  return {state,actions};
}

export interface HerdrBlindState {count:number;lastAt:number;sessionFile:string|null}
export function observeHerdrBlind(pane:'working'|'idle'|'done'|'missing'|'unknown',writeAgeMinutes:number|null,
  sessionFile:string|undefined,now:number,prior:HerdrBlindState|undefined,paradaMin:number):HerdrBlindState {
  const blind=(pane==='idle'||pane==='done')&&writeAgeMinutes!==null&&writeAgeMinutes<paradaMin;
  const consecutive=blind&&prior?.count>0&&prior.sessionFile===sessionFile&&now-prior.lastAt<=10*60_000?prior.count+1:blind?1:0;
  return {count:consecutive,lastAt:now,sessionFile:sessionFile??null};
}
export interface ContextAlert {fingerprint:string;text:string;threshold:number}
export function contextAlerts(office:string,sessionFile:string,percent:number|null,taskId:string|null,contextThreshold:number,seen:ReadonlySet<string>):ContextAlert[] {
  if(percent===null||!Number.isFinite(percent)||percent<0||percent>100)return [];
  const candidates:ContextAlert[]=[];
  if(percent>=contextThreshold)candidates.push({threshold:contextThreshold,fingerprint:`context:${sessionFile}:notice:${contextThreshold}`,
    text:`Contexto de ${office} al ${Math.floor(percent)}% — al 70 se relanza entre tareas`});
  if(taskId&&percent>=70)candidates.push({threshold:70,fingerprint:`context:${sessionFile}:70:${taskId}`,
    text:`${office} al ${Math.floor(percent)}% con ${taskId} en curso — se relanza al entregar`});
  if(taskId&&percent>=85)candidates.push({threshold:85,fingerprint:`context:${sessionFile}:85:${taskId}`,
    text:`${office} al ${Math.floor(percent)}% con ${taskId} en curso — riesgo de overflow`});
  return candidates.filter(row=>!seen.has(row.fingerprint));
}
