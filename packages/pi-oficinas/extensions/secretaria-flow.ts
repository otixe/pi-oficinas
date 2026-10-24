import { teamConfig } from '../lib/team-config.ts';
import {blockType, leaderAlerts, orderLeaderNotices, questionId, questionState, returnedForChanges, taskAvailabilityTransition, parseOfficeNotice, parseLeaderNotice, type PaneQuietState, type LeaderNotice, type TaskEvent} from './secretaria-core.ts';

export interface TaskApi {
  get(path:string):Promise<any>;
  post(path:string,body:Record<string,unknown>):Promise<any>;
}
const taskPath=(path:string,id:string)=>`/task/${path}?task_id=${encodeURIComponent(id)}`;
export const OFFICE_TASK_LIST_LIMIT=500;
/** A bound applies PER office/status, never to a silently filtered global census. */
export async function listOfficeStatus(api:Pick<TaskApi,'get'>,office:string,status:string):Promise<any[]> {
  const response=await api.get(`/task/list?status=${encodeURIComponent(status)}&assignee=${encodeURIComponent(office)}&limit=${OFFICE_TASK_LIST_LIMIT}`);
  const tasks=Array.isArray(response)?response:response?.tasks;
  if(!Array.isArray(tasks))throw new Error('Barrido: lista de tareas inválida');
  if(tasks.length>=OFFICE_TASK_LIST_LIMIT)
    throw new Error(`Barrido incompleto: límite ${OFFICE_TASK_LIST_LIMIT} para ${office}/${status}; no declarar cobertura total`);
  return tasks;
}
/** Canonicalize every external task ID before a write. The server decides whether a prefix is unique. */
async function fullTaskId(api:TaskApi, supplied:string):Promise<{id:string;task:any}> {
  if(typeof supplied!=='string'||!supplied.trim())throw new Error('ID de tarea inexistente o ambiguo');
  let task:any;
  try { task=await api.get(taskPath('get',supplied)); }
  catch { throw new Error(`ID de tarea inexistente o ambiguo: ${supplied}`); }
  if(typeof task?.id!=='string'||!task.id||!task.id.startsWith(supplied))
    throw new Error(`ID de tarea inexistente o ambiguo: ${supplied}`);
  return {id:task.id,task};
}
const events=(raw:any):TaskEvent[]=>Array.isArray(raw?.events)?raw.events:[];
export interface DependencyCensus {ids:string[];pendingIds:string[];pendingCount:number;allDone:boolean}
/** Source of truth for every dependency decision: fresh server list AND fresh task status per ID. */
export async function dependencyCensus(api:TaskApi, taskId:string):Promise<DependencyCensus> {
  const deps=await api.get(taskPath('deps',taskId));
  if(!Array.isArray(deps?.blocked_by))throw new Error('Dependencias no verificables; NO desbloquear');
  const ids=deps.blocked_by.map((raw:any)=>typeof raw==='string'?raw:raw?.id);
  if(ids.some((id:unknown)=>typeof id!=='string'||!id||id===taskId) || new Set(ids).size!==ids.length)
    throw new Error('IDs de dependencias ambiguos; NO desbloquear');
  const states=await Promise.all(ids.map((id:string)=>api.get(taskPath('get',id))));
  if(states.some((state:any,i:number)=>state?.id!==ids[i]||typeof state?.status!=='string'))
    throw new Error('Estado de dependencia no verificable; NO desbloquear');
  const pendingIds=states.filter((state:any)=>state.status!=='done').map((state:any)=>state.id);
  const pendingCount=pendingIds.length;
  return {ids,pendingIds,pendingCount,allDone:pendingCount===0};
}
async function ancestorRelation(api:TaskApi, task:any, candidateId:string):Promise<'ancestor'|'not-ancestor'|'unreadable'> {
  if(candidateId===task.id)return 'ancestor';
  const seen=new Set<string>([task.id]);let current=task;
  while(current?.parent_id!==undefined && current.parent_id!==null && current.parent_id!=='') {
    if(typeof current.parent_id!=='string'||seen.has(current.parent_id))return 'unreadable';
    let parent:{id:string;task:any};
    try{parent=await fullTaskId(api,current.parent_id);}catch{return 'unreadable';}
    if(seen.has(parent.id))return 'unreadable';
    if(parent.id===candidateId)return 'ancestor';
    seen.add(parent.id);current=parent.task;
  }
  return current && (current.parent_id===undefined || current.parent_id===null || current.parent_id==='')
    ? 'not-ancestor' : 'unreadable';
}

export type EffectKind='question'|'response'|'block'|'delivery'|'dependency'|'quiet'|'task-available';
export interface ExpectedEffect {office?:string; actor?:string; id?:string; body?:string; bodyHash?:string; status?:string; at?:string; transition?:'review'|'handoff'|'todo'|'unblock'; afterCount?:number; needsUnblock?:boolean; requireBlocked?:boolean; pendingDependencies?:number; pendingDependencyId?:string; pendingQuestionId?:string; unanswered?:boolean; now?:number; quietMs?:number; paneState?:PaneQuietState}
/** Single falsifiable gate before every bell or grouped notice. No response 200 is evidence by itself. */
export async function confirmarEfecto(api:TaskApi, tipo:EffectKind, taskId:string, expected:ExpectedEffect={}):Promise<boolean> {
  try {
    const task=await api.get(taskPath('get',taskId));
    if(!task || task.id!==taskId || (expected.status && task.status!==expected.status))return false;
    const raw=await api.get(taskPath('activity',taskId));
    if(!Array.isArray(raw?.events))return false;
    const activity:TaskEvent[]=raw.events;
    if(expected.afterCount!==undefined && activity.length<=expected.afterCount)return false;
    const freshEvents=expected.afterCount!==undefined?activity.slice(expected.afterCount):activity;
    const {questions,responses}=questionState(activity);
    if(tipo==='question')return !!expected.id && ['todo','in_progress','blocked'].includes(task.status) &&
      task.assignee===expected.office &&
      questions.get(expected.id)?.agent===expected.office && (!expected.unanswered || !responses.has(expected.id)) &&
      (!expected.needsUnblock || task.status==='blocked');
    if(tipo==='response') {
      if(!expected.id || !['todo','in_progress','blocked'].includes(task.status) || !responses.has(expected.id) ||
         questions.get(expected.id)?.agent!==task.assignee ||
         (expected.requireBlocked && task.status!=='blocked') ||
         (expected.needsUnblock && task.status!=='in_progress'))return false;
      if(expected.pendingDependencies!==undefined) {
        const census=await dependencyCensus(api,taskId);
        if(census.pendingCount!==expected.pendingDependencies || (expected.requireBlocked && census.pendingCount===0 && !expected.pendingQuestionId))return false;
        if(expected.pendingDependencyId && !census.pendingIds.includes(expected.pendingDependencyId))return false;
        if(expected.pendingQuestionId) {
          if(census.pendingCount!==0 || task.status!=='blocked' || blockType(task.blocked_reason)==='dependency')return false;
          return questions.has(expected.pendingQuestionId) && !responses.has(expected.pendingQuestionId);
        }
        return true;
      }
      return true;
    }
    if(tipo==='block') {
      const latest=[...freshEvents].reverse().find(e=>e.kind==='block');
      return task.status==='blocked' && task.assignee===expected.office && latest?.agent===(expected.actor??expected.office) &&
        latest?.to_status==='blocked' && (!expected.at || latest?.created_at===expected.at);
    }
    if(tipo==='delivery') {
      if(task.assignee!==expected.office)return false;
      if(expected.body!==undefined) return freshEvents.some(e=>e.kind==='comment'&&e.agent===expected.office&&e.body===expected.body);
      if(expected.bodyHash!==undefined) return !['done','cancelled'].includes(task.status) &&
        freshEvents.some(e=>e.kind==='comment'&&e.agent===expected.office&&
        typeof e.body==='string'&&e.body.startsWith(`ENTREGA·${expected.office}\n`) &&
        questionId(expected.office!,taskId,e.body)===expected.bodyHash);
      return task.status==='submitted' && task.submitted_by===expected.office &&
        freshEvents.some(e=>e.kind==='status_change'&&e.to_status==='submitted'&&e.agent===expected.office&&
          (!expected.at||e.created_at===expected.at));
    }
    if(tipo==='dependency') {
      if(task.status!=='blocked' || task.assignee!==expected.office || blockType(task.blocked_reason)!=='dependency')return false;
      const census=await dependencyCensus(api,taskId);
      return census.ids.length>0 && census.allDone;
    }
    if(tipo==='quiet') {
      if(!expected.paneState || expected.paneState==='working')return false; // no declarar silencio con pane sin medir.
      const last=activity.at(-1)?.created_at;
      return task.status==='in_progress' && task.assignee===expected.office &&
        !!last && Number.isFinite(Date.parse(last)) &&
        (expected.now??Date.now())-Date.parse(last)>(expected.quietMs??30*60_000);
    }
    if(tipo==='task-available'){
      const transition=taskAvailabilityTransition(activity);
      const latestState=activity.filter(e=>e && typeof e==='object' && (e.to_status!=null || e.kind==='handoff')).at(-1);
      const matches=!!transition && (!expected.transition || transition.kind===expected.transition) &&
        (!expected.at || transition.at===expected.at);
      const statusAvailable=task.status==='todo'
        ? (!latestState || transition?.kind==='todo' || transition?.kind==='handoff') && (!expected.transition || matches)
        : task.status==='in_progress' ? matches
        : task.status==='submitted' ? matches && (transition?.kind==='review' || transition?.kind==='todo' ||
            (transition?.kind==='handoff' && returnedForChanges(activity)))
        : false;
      if(task.assignee!==expected.office || !statusAvailable)return false;
      return (await dependencyCensus(api,taskId)).allDone;
    }
    return false;
  }catch{return false;}
}
export async function anunciarEfecto(api:TaskApi,tipo:EffectKind,taskId:string,expected:ExpectedEffect,
  announce:()=>void):Promise<boolean> {
  if(!await confirmarEfecto(api,tipo,taskId,expected))return false;
  announce();return true;
}
export type NoticeAction='read-task'|'read-answer'|'stay-blocked'|'resume'|'read-question'|'read-block'|'read-delivery'|'read-dependency'|'read-quiet'|'read-correspondence'|'inspect-status'|'ignore-stale';
/** The same receiving decision used by Pi input and by the 72-cell matrix. */
export async function acceptOfficeNotice(api:TaskApi,text:string,office:string):Promise<{action:NoticeAction;taskId?:string;questionId?:string}> {
  const parsed=parseOfficeNotice(text);
  if(!parsed)return {action:'ignore-stale'};
  const task=await api.get(taskPath('get',parsed.taskId)).catch(()=>null);
  if(task?.id!==parsed.taskId || task.assignee!==office)return {action:'ignore-stale'};
  if(parsed.kind==='task-available') return await confirmarEfecto(api,'task-available',task.id,{office})
    ? {action:'read-task',taskId:task.id}:{action:'ignore-stale'};
  if(parsed.kind==='dependency')return await confirmarEfecto(api,'dependency',task.id,{office})
    ? {action:'resume',taskId:task.id}:{action:'ignore-stale'};
  if(!parsed.questionId || (parsed.status==='blocked' &&
      !((parsed.pendingDependencies??0)>0 && (parsed.pendingDependencyId || !parsed.pendingQuestionId) || parsed.pendingQuestionId)) ||
     (parsed.status && parsed.status!==task.status) || (!parsed.status && task.status==='blocked'))return {action:'ignore-stale'};
  const pending=parsed.status==='blocked';
  const valid=await confirmarEfecto(api,'response',task.id,{office,id:parsed.questionId,status:task.status,
    needsUnblock:task.status==='in_progress',requireBlocked:pending,
    ...(pending?{pendingDependencies:parsed.pendingDependencies,
      ...(parsed.pendingDependencyId?{pendingDependencyId:parsed.pendingDependencyId}:{}),
      ...(parsed.pendingQuestionId?{pendingQuestionId:parsed.pendingQuestionId}:{})}:{})});
  return valid?{action:pending?'stay-blocked':'read-answer',taskId:task.id,questionId:parsed.questionId}:{action:'ignore-stale'};
}
export async function acceptLeaderNotice(api:TaskApi,text:string,now=Date.now(),
  probePane?:(task:any)=>Promise<{state:PaneQuietState}>|{state:PaneQuietState}):Promise<{action:NoticeAction;taskId?:string}> {
  const parsed=parseLeaderNotice(text);
  if(!parsed)return {action:'ignore-stale'};
  if(parsed.kind==='correspondence')return {action:'read-correspondence',taskId:parsed.taskId};
  const task=await api.get(taskPath('get',parsed.taskId)).catch(()=>null);
  if(task?.id!==parsed.taskId || ![teamConfig().lider,(process.env.PI_OFICINAS_HUMAN || 'human')].includes(task.creator) ||
     (parsed.office && parsed.office!==task.assignee) ||
     (!parsed.office && task.creator!==teamConfig().lider))return {action:'ignore-stale'};
  const office=task.assignee;
  if(parsed.kind==='question'){
    const activity=await api.get(taskPath('activity',task.id)).catch(()=>null);
    const state=questionState(events(activity));
    for(const id of state.questions.keys())if(await confirmarEfecto(api,'question',task.id,{office,id,unanswered:true,...(parsed.status?{status:parsed.status}:{})}))
      return {action:'read-question',taskId:task.id};
  }
  if(parsed.kind==='block' && (!parsed.blockKind || parsed.blockKind===blockType(task.blocked_reason)) &&
     await confirmarEfecto(api,'block',task.id,{office}))return {action:'read-block',taskId:task.id};
  if(parsed.kind==='delivery'){
    if(await confirmarEfecto(api,'delivery',task.id,{office}))return {action:'read-delivery',taskId:task.id};
    const history=events(await api.get(taskPath('activity',task.id)).catch(()=>null));
    for(const entry of history)if(entry.kind==='comment'&&entry.agent===office&&entry.body?.startsWith(`ENTREGA·${office}\n`) &&
       await confirmarEfecto(api,'delivery',task.id,{office,body:entry.body}))return {action:'read-delivery',taskId:task.id};
  }
  if(parsed.kind==='dependency' && await confirmarEfecto(api,'dependency',task.id,{office}))return {action:'read-dependency',taskId:task.id};
  if(parsed.kind==='quiet'){
    if(!probePane||!parsed.paneState)return {action:'ignore-stale'};
    let state:PaneQuietState='unknown';try{state=(await probePane(task)).state}catch{}
    if(state!==parsed.paneState)return {action:'ignore-stale'};
    if(await confirmarEfecto(api,'quiet',task.id,{office,now,paneState:state}))
      return {action:state==='unknown'?'inspect-status':'read-quiet',taskId:task.id};
  }
  return {action:'ignore-stale'};
}
export async function askOffice(api:TaskApi, office:string, taskId:string, question:string, blocks:boolean,
                                dependsOnId?:string):Promise<{id:string;task:any;newQuestion:boolean;dependencyWarning?:string}> {
  if (!question?.trim() || question.length>4000) throw new Error('Pregunta vacía o mayor a 4000 caracteres');
  const {task}=await fullTaskId(api,taskId);
  let fullDependsOnId=dependsOnId?(await fullTaskId(api,dependsOnId)).id:undefined;
  if (!task?.id || task.assignee!==office || !['todo','in_progress','blocked'].includes(task.status))
    throw new Error('Tarea no corresponde a la oficina');
  let dependencyWarning:string|undefined;
  if(fullDependsOnId) {
    const relation=await ancestorRelation(api,task,fullDependsOnId);
    if(relation==='ancestor' || relation==='unreadable') {
      dependencyWarning=relation==='ancestor'
        ?'DEPENDE_DE apunta a tu tarea madre/ancestro: no se registró como dependencia (bloquearía tu propia tarea)'
        :'No se pudo leer la jerarquía parent_id: DEPENDE_DE no se registró como dependencia (podría bloquear tu propia tarea)';
      fullDependsOnId=undefined;
    }
  }
  taskId=task.id;
  dependsOnId=fullDependsOnId;
  const effects:string[]=[];
  try {
  const id=questionId(office,task.id,question.trim()+(dependsOnId?`|depends_on:${dependsOnId}`:''));
  const history=events(await api.get(taskPath('activity',task.id)));
  const state=questionState(history);
  if(state.responses.has(id)) return {id,task:await api.get(taskPath('get',task.id)),newQuestion:false,dependencyWarning}; // duplicate after answer cannot re-block.
  const newQuestion=!state.questions.has(id);
  if(newQuestion) {
    effects.push('comentario solicitado (confirmar en actividad)');
    await api.post('/task/comment',{task_id:task.id,
      body:`PREGUNTA·${office}·${id}\n${dependsOnId?`DEPENDE_DE·${dependsOnId}\n`:''}${question.trim()}`});
    if(!await confirmarEfecto(api,'question',task.id,{office,id})) throw new Error('PREGUNTA sin comentario confirmado; NO timbrar');
    effects[effects.length-1]='comentario confirmado';
  }
  if(dependsOnId) {
    if(dependsOnId===task.id) throw new Error('Dependencia circular directa');
    const deps=await api.get(taskPath('deps',task.id));
    const linked=Array.isArray(deps?.blocked_by) && deps.blocked_by.some((d:any)=> (typeof d==='string'?d:d?.id)===dependsOnId);
    if(!linked) { effects.push('enlace solicitado (confirmar en dependencias)'); await api.post('/task/link',{task_id:task.id,depends_on_id:dependsOnId}); }
    if(!(await dependencyCensus(api,task.id)).ids.includes(dependsOnId)) throw new Error('task_link sin efecto confirmado');
    if(!linked) effects[effects.length-1]='enlace confirmado';
  }
  const current=await api.get(taskPath('get',task.id));
  if(current?.id!==task.id || current.assignee!==office || !['todo','in_progress','blocked'].includes(current.status))
    throw new Error('Tarea cambió mientras se registraba pregunta; NO timbrar');
  if(blocks && current.status!=='blocked') { effects.push('bloqueo solicitado (confirmar estado)'); await api.post('/task/block',{task_id:task.id,reason:dependsOnId?'dependency':'info'}); }
  if(blocks && !await confirmarEfecto(api,'block',task.id,{office})) throw new Error('Block no confirmado; NO timbrar como bloqueada');
  if(blocks && current.status!=='blocked') effects[effects.length-1]='bloqueo confirmado';
  const final=await api.get(taskPath('get',task.id));
  if(final?.id!==task.id || final.assignee!==office || !['todo','in_progress','blocked'].includes(final.status) || (blocks && final.status!=='blocked'))
    throw new Error('Estado final de pregunta no confirmado; NO timbrar');
  return {id,task:final,newQuestion,dependencyWarning};
  } catch(error) {
    if(effects.length)throw new Error(`${String(error)}; estado parcial: ${effects.join('; ')}`);
    throw error;
  }
}
export function taskAvailableNotice(task:{id:string;status:string;assignee:string}){
  return {text:`🔔 Tenés la tarea ${task.id} — leela en el tablero`,expected:{office:task.assignee,status:task.status}};
}
export function deliveryNotice(task:{id:string},office:string){
  return {text:`🔔 ${office} entregó la tarea ${task.id} — leela en el tablero`};
}
export function dependencyNotice(taskId:string){
  return {text:`🔔 Dependencia resuelta en ${taskId} — leela en el tablero`};
}
export function questionNotice(task:{id:string;status:string},office:string,id:string){
  return {text:`🔔 ${office} preguntó en ${task.id} — leela en el tablero (estado: ${task.status})`,
    expected:{office,id,unanswered:true,status:task.status}};
}
export function blockNotice(task:{id:string;status:string},office:string,type:string){
  return {text:`🔔 ${office} bloqueó ${task.id}: ${type} — leela en el tablero`,
    expected:{office,status:task.status}};
}
export function responseNotice(task:{id:string;status:string;assignee:string}, questionIdValue:string, pendingDependencies:number, unblockedNow:boolean,
  pendingDependencyIds:string[]=[], pendingQuestionIds:string[]=[]) {
  if(task.status==='blocked' && pendingDependencies>0) {
    const dependencyId=pendingDependencyIds[0];
    if(!dependencyId)throw new Error('Dependencia pendiente sin ID verificable; NO timbrar stay-blocked');
    return {
      expected:{office:task.assignee,id:questionIdValue,needsUnblock:false,requireBlocked:true,pendingDependencies,
        pendingDependencyId:dependencyId,status:task.status},
      text:`🔔 respuesta disponible en ${task.id} pregunta ${questionIdValue}; sigue bloqueada: dependencia ${dependencyId} no done (${pendingDependencies} pendientes) — leela en el tablero`,
    };
  }
  if(task.status==='blocked' && pendingQuestionIds.length>0) {
    const pendingQuestionId=pendingQuestionIds[0];
    return {expected:{office:task.assignee,id:questionIdValue,needsUnblock:false,requireBlocked:true,pendingDependencies:0,
        pendingQuestionId,status:task.status},
      text:`🔔 respuesta disponible en ${task.id} pregunta ${questionIdValue}; sigue bloqueada: pregunta abierta ${pendingQuestionId} — leela en el tablero`};
  }
  if(task.status==='todo' || task.status==='in_progress') return {
    expected:{office:task.assignee,id:questionIdValue,needsUnblock:unblockedNow,requireBlocked:false,status:task.status},
    text:`🔔 ${teamConfig().lider} respondió ${task.id} pregunta ${questionIdValue} — leela en el tablero (estado: ${task.status})`,
  };
  throw new Error('Estado final incompatible con respuesta; NO timbrar');
}
export async function answerOffice(api:TaskApi, taskId:string, questionIdValue:string, answer:string):Promise<{task:any;answeredNow:boolean;unblockedNow:boolean;pendingDependencies:number;pendingDependencyIds:string[];pendingQuestionIds:string[]}> {
  if(!answer?.trim() || answer.length>4000 || !/^[a-f0-9]{16}$/.test(questionIdValue)) throw new Error('Respuesta o ID inválidos');
  const {task}=await fullTaskId(api,taskId);
  taskId=task.id;
  if(!task?.id || task.creator!==teamConfig().lider || typeof task.assignee!=='string' ||
     !['todo','in_progress','blocked'].includes(task.status)) throw new Error('Tarea ajena o estado finalizado; NO responder');
  const history=events(await api.get(taskPath('activity',task.id)));
  const {questions,responses}=questionState(history);
  const question=questions.get(questionIdValue);
  if(!question || question.agent!==task.assignee) throw new Error('Pregunta no verificada para esta oficina');
  const answeredNow=!responses.has(questionIdValue);
  const depMatch=/^PREGUNTA·[a-z][a-z0-9-]{0,39}·[a-f0-9]{16}\nDEPENDE_DE·([^\n]+)\n([\s\S]*)$/.exec(question.body ?? '');
  const dependsOn=depMatch && questionId(task.assignee,task.id,depMatch[2]+`|depends_on:${depMatch[1]}`)===questionIdValue
    ? (await fullTaskId(api,depMatch[1])).id : undefined; // preserve legacy hash, compare/link canonical IDs.
  const effects:string[]=[];
  try {
  if(dependsOn) {
    if(dependsOn===task.id) throw new Error('Dependencia circular directa');
    if(task.status==='todo') throw new Error('Tarea todo con dependencia: reclamar antes de responder');
    const deps=await api.get(taskPath('deps',task.id));
    const linked=Array.isArray(deps?.blocked_by) && deps.blocked_by.some((d:any)=>(typeof d==='string'?d:d?.id)===dependsOn);
    if(!linked) { effects.push('enlace solicitado (confirmar en dependencias)'); await api.post('/task/link',{task_id:task.id,depends_on_id:dependsOn}); }
  }
  const census=await dependencyCensus(api,task.id); // ALL links, not only the one cited in the question.
  if(dependsOn && !census.ids.includes(dependsOn)) throw new Error('task_link no confirmado; NO desbloquear');
  if(dependsOn && effects.at(-1)?.startsWith('enlace solicitado')) effects[effects.length-1]='enlace confirmado';
  const current=await api.get(taskPath('get',task.id));
  if(current?.id!==task.id || current.creator!==teamConfig().lider || current.assignee!==task.assignee ||
     !['todo','in_progress','blocked'].includes(current.status) || (current.status==='todo' && census.ids.length>0))
    throw new Error('Tarea cambió o tiene dependencia en todo; NO responder');
  if(current.status==='blocked' && blockType(current.blocked_reason)==='dependency' && census.ids.length===0)
    throw new Error('Bloqueo por dependencia sin vínculos verificables; NO desbloquear');
  if(answeredNow) {
    effects.push('comentario solicitado (confirmar en actividad)');
    await api.post('/task/comment',{task_id:task.id,body:`RESPUESTA·${teamConfig().lider}·${questionIdValue}\n${answer.trim()}`});
    if(!await confirmarEfecto(api,'response',task.id,{office:task.assignee,id:questionIdValue}))
      throw new Error(`RESPUESTA·${teamConfig().lider} no confirmada en actividad; NO timbrar`);
    effects[effects.length-1]='comentario confirmado';
  }
  let unblockedNow=false;
  const latestQuestions=questionState(events(await api.get(taskPath('activity',task.id))));
  const hasOpenQuestions=[...latestQuestions.questions.keys()].some(id=>!latestQuestions.responses.has(id));
  if(current.status==='blocked' && census.allDone && !hasOpenQuestions) {
    effects.push('desbloqueo solicitado (confirmar estado)');
    await api.post('/task/unblock',{task_id:task.id,note:`respuesta ${questionIdValue}`});
    if(!await confirmarEfecto(api,'response',task.id,{office:task.assignee,id:questionIdValue,needsUnblock:true}))
      throw new Error('Unblock no confirmado en in_progress; NO timbrar respuesta');
    effects[effects.length-1]='desbloqueo confirmado';
    unblockedNow=true;
  }
  if(current.status==='in_progress' && dependsOn && !census.allDone) {
    effects.push('bloqueo solicitado (confirmar estado)');
    await api.post('/task/block',{task_id:task.id,reason:'dependency'});
    if(!await confirmarEfecto(api,'block',task.id,{office:task.assignee,actor:teamConfig().lider}))
      throw new Error('Dependencia no bloqueada; NO fingir espera');
    effects[effects.length-1]='bloqueo confirmado';
  }
  let final=await api.get(taskPath('get',task.id));
  let finalCensus=await dependencyCensus(api,task.id);
  if(final?.id!==task.id || final.assignee!==task.assignee || !['todo','in_progress','blocked'].includes(final.status))
    throw new Error('Estado final de respuesta no verificable; NO timbrar');
  if(final.status==='blocked' && finalCensus.ids.length>0 && finalCensus.allDone) {
    effects.push('desbloqueo solicitado (confirmar estado)');
    await api.post('/task/unblock',{task_id:task.id,note:`respuesta ${questionIdValue}`});
    if(!await confirmarEfecto(api,'response',task.id,{office:task.assignee,id:questionIdValue,needsUnblock:true}))
      throw new Error('Unblock tardío no confirmado; NO timbrar');
    effects[effects.length-1]='desbloqueo confirmado';
    unblockedNow=true;
    final=await api.get(taskPath('get',task.id));finalCensus=await dependencyCensus(api,task.id);
  }
  if(final.status==='todo' && finalCensus.ids.length>0) throw new Error('Tarea todo con dependencias al cierre; NO timbrar');
  if(final.status==='in_progress' && finalCensus.pendingCount>0) throw new Error('Dependencias pendientes con tarea in_progress; NO anunciar reanudación');
  const finalHistory=events(await api.get(taskPath('activity',task.id)));
  const finalQuestionState=questionState(finalHistory);
  const pendingQuestionIds=[...finalQuestionState.questions.keys()].filter(id=>!finalQuestionState.responses.has(id));
  return {task:final,answeredNow,unblockedNow,pendingDependencies:finalCensus.pendingCount,
    pendingDependencyIds:finalCensus.pendingIds,pendingQuestionIds};
  } catch(error) {
    if(effects.length)throw new Error(`${String(error)}; estado parcial: ${effects.join('; ')}`);
    throw error;
  }
}
export async function leaderSweep(api:TaskApi, officeNames:Set<string>, now=Date.now(), quietMs=30*60_000,
  probePane?:(task:any)=>Promise<{state:PaneQuietState;lastSessionWriteAt?:number}>|{state:PaneQuietState;lastSessionWriteAt?:number}):Promise<LeaderNotice[]> {
  const all:any[]=[];
  for(const office of officeNames) {
    for(const status of ['blocked','in_progress','todo']) {
      all.push(...await listOfficeStatus(api,office,status));
    }
  }
  const alerts:LeaderNotice[]=[];
  for(const item of all) {
    if(!item?.id || !officeNames.has(item.assignee)) continue;
    const task=await api.get(taskPath('get',item.id));
    if(task.creator!==teamConfig().lider || !officeNames.has(task.assignee)) continue;
    const history=events(await api.get(taskPath('activity',task.id)));
    let paneState:PaneQuietState|undefined,lastSessionWriteAt:number|undefined;
    const last=history.at(-1)?.created_at;
    const stale=typeof last==='string'&&Number.isFinite(Date.parse(last))&&now-Date.parse(last)>quietMs;
    if(task.status==='in_progress'&&stale)try{const observation=probePane?await probePane(task):{state:'unknown' as const};paneState=observation.state;lastSessionWriteAt=observation.lastSessionWriteAt;}
      catch{paneState='unknown'}
    alerts.push(...leaderAlerts(task,history,now,quietMs,paneState,lastSessionWriteAt));
    if(task.status==='blocked' && blockType(task.blocked_reason)==='dependency') {
      const census=await dependencyCensus(api,task.id);
      if(census.ids.length && census.allDone) alerts.push({kind:'dependency',task_id:task.id,
        fingerprint:`dependency:${task.id}:${[...census.ids].sort().join(',')}`,
        text:`Dependencia lista para ${task.assignee} en ${task.id} — leela en el tablero`});
    }
  }
  return orderLeaderNotices([...new Map(alerts.map(n=>[n.fingerprint,n])).values()]);
}
