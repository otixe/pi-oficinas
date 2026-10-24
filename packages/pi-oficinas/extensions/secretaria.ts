import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_HEADER, parseEnvFile, resolveAgentNameFromPrompt, resolveIdentityFrom, safeSubagentShapeSignal } from '../lib/cerebro-identity.ts';
import { teamConfig, teamRole, secretaryConfig } from '../lib/team-config.ts';
import { deliveryMode, isOfficeBody, logBell, lookupPane, ownerDelivery, practitionerAllowed, returnedForChanges, taskAvailabilityTransition, persistBellRetry, taggedCandidates, orderReadyTasks, unseenIds, blockType, questionId, questionState, queueLeaderBell, ring, parseOfficeNotice, observePaneQuiet, validPaneId, unblockedLatest, type LeaderNotice } from './secretaria-core.ts';
import { startCostSession, recordCostClaim, reportTaskCost } from './secretaria-cost.ts';
import { contextSnapshot, shouldDeferNewTask, persistContextSnapshot, readContextSnapshot } from './context70.ts';
import { parsePaneObservation, collectPaneHealth, monitorVerdict } from './secretaria-monitor.ts';
import { detectTaskHealth, contextAlerts, healthTaskEligible, observeHerdrBlind, type TaskDetectorState, type HerdrBlindState } from './secretaria-vigilancia.ts';
import { readPrivateJson, writePrivateJson, readPrivateJsonLines, appendPrivateJsonLine, quarantinePrivateFile, quarantineUnsafeFile, compactCorrespondenceLedger, rewritePrivateJsonLines, JSONL_MAX_BYTES } from './secretaria-state.ts';
import { externalLeaderRecipients, extractSuccessfulCode, formatIncomingBell, formatBatchedBell, coldStartSeenCodes, humanRecentlyActive } from './secretaria-correspondence.ts';
import { fetchCerebro, timedFetch } from './secretaria-cerebro-client.ts';
import { resolveLeaderNames, LEADER_REGISTRY_TIMEOUT_MS } from './secretaria-leader-registry.ts';
import { emitSecretarialNotices, processIncomingCorrespondence, checkSecretarialAcknowledgements, f4WindowCount,
  pendingBatchedMedium, pendingLowCount, shouldSendBatch, type CorrespondenceLedgerRow } from './secretaria-correspondence-flow.ts';
import { parseContextNotice, formatContextNotice, coordinateContextRelaunch, retryPendingContextRelaunch, type ContextNotice } from './context-relaunch.ts';
import { buildContextRelaunchDeps } from './context-leader-adapter.ts';
import { readPendingContext, writePendingContext } from './context-pending.ts';
import { asignarVmTurno, estadoVmTurno, liberarVmTurno, marcarVencimientoVmTurno, pedirVmTurno, quitarVmTurno } from './vm-turno.ts';
import {askOffice,answerOffice,responseNotice,questionNotice,blockNotice,taskAvailableNotice,deliveryNotice,dependencyNotice,acceptOfficeNotice,acceptLeaderNotice,leaderSweep,listOfficeStatus,confirmarEfecto,anunciarEfecto,dependencyCensus,type EffectKind,type ExpectedEffect} from './secretaria-flow.ts';

const cerebroBase=(ctx:ExtensionContext)=> (process.env.CEREBRO_BASE||parseEnvFile(ctx.cwd).CEREBRO_BASE||'').replace(/\/$/,'');
const registryPath = () => join(teamConfig().base,'registro.json');
const teamBellLog = () => join(teamConfig().base,'timbres.jsonl');
const teamLeaderQueue=() => join(teamConfig().base,'leader-notices.jsonl');
function registry(): Record<string,{pane_id?: string}> { return JSON.parse(readFileSync(registryPath(),'utf8')); }
function identity(ctx: ExtensionContext) {
  const cfg=teamConfig();
  const role=teamRole(cfg,ctx.cwd,isOfficeBody(ctx.cwd),parseEnvFile(ctx.cwd).AGENT_NAME);
  if(role==='none') throw new Error('Cuerpo ajeno al equipo: fail-closed');
  const prompt = () => ctx.getSystemPrompt();
  const id = resolveIdentityFrom(resolveAgentNameFromPrompt(prompt()), parseEnvFile(ctx.cwd), process.env, safeSubagentShapeSignal(prompt));
  if (!id.key || id.owner === 'AMBIGUOUS' || id.owner !== (role==='leader'?cfg.lider:parseEnvFile(ctx.cwd).AGENT_NAME) ||
      id.isSubagent !== (role==='office')) throw new Error('Identidad sin key o rol: fail-closed');
  return id;
}
async function get(ctx: ExtensionContext, path: string, timeoutMs = 15_000) {
  const id = identity(ctx);
  const response = await fetchCerebro(cerebroBase(ctx), path, {headers: {[AUTH_HEADER]: id.key}}, timeoutMs);
  return response.json();
}
async function post(ctx: ExtensionContext, path: string, body: Record<string,unknown>, onAccepted?:()=>void) {
  const id=identity(ctx);
  const response=await fetchCerebro(cerebroBase(ctx), path, {method:'POST',headers:{[AUTH_HEADER]:id.key,'Content-Type':'application/json'},
    body:JSON.stringify(body)}, 15_000);
  onAccepted?.();
  return response.json();
}
function isPractitionerSession(ctx: ExtensionContext): boolean {
  try {
    const header=ctx.sessionManager?.getHeader?.();
    const file=ctx.sessionManager?.getSessionFile?.();
    return !!header?.parentSession || (typeof file==='string' && dirname(file).split(/[\\/]/).at(-1)==='tasks');
  }catch {return true;} // uncertain structure cannot authorize a question.
}
export default function(pi: ExtensionAPI, contextWiring?: {buildDeps?:typeof buildContextRelaunchDeps}) {
  if (!(process.env.PI_OFICINAS_EQUIPO || parseEnvFile(process.cwd()).PI_OFICINAS_EQUIPO)) return; // unconfigured means inactive, not an implicit foreign team
  const bellLog=teamBellLog(), leaderQueue=teamLeaderQueue();
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaderTimer: ReturnType<typeof setInterval> | undefined;
  let vmTurnTimer: ReturnType<typeof setInterval> | undefined;
  let correspondenceTimer: ReturnType<typeof setInterval> | undefined;
  const pendingEffects=new Map<string,{taskId:string;count:number}>();
  const announcedContext=new Set<string>();
  const contextAlerted=new Set<string>();
  const pendingContext=new Map<string,ContextNotice>();
  let sweeping=false;
  let correspondencePolling=false;
  // Carga sobre el Cerebro (98bf4465, medido por reviewer/reviewer el 2026-10-08: 1099 requests en 5 min,
  // el 76% desde la VM de oficinas). El barrido de 60 s de cada oficina pedía 4 /task/list (todo
  // repetido), un /task/get por tarea y un /task/activity por tarea activa EN CADA CICLO, aunque
  // nada hubiera cambiado. Ahora: UNA /task/list sin status (el default del Cerebro trae todas las
  // no terminales: todo, in_progress, blocked y submitted, medido) filtrada en memoria; /task/get
  // cacheado mientras el status y el assignee de la lista no cambien (máx. 10 min); /task/activity
  // sólo si cambió el status, si hay una pregunta propia todavía sin respuesta anunciada, o cada
  // 10 min como red. El intervalo de 60 s NO cambia.
  const OFFICE_POLL_TTL_MS=10*60_000;
  const officeTaskDetail=new Map<string,{status:string;assignee:string;task:any;at:number}>();
  const officeActivityState=new Map<string,{status:string;open:boolean;at:number}>();
  const leaderSeenPath=join(teamConfig().lider_body,'state','secretaria-lider-seen.json');
  const offices=new Set(teamConfig().oficinas);
  const registeredRole=teamRole(teamConfig(),process.cwd(),isOfficeBody(process.cwd()),parseEnvFile(process.cwd()).AGENT_NAME);
  if(registeredRole==='none') return; // An arbitrary new body cannot inherit coordinator's fallback or write its state.
  const vmTurnRoster=()=>{const cfg=teamConfig();return [...cfg.oficinas,cfg.lider];};
  function notifyVmTurn(recipient:string, taskId:string, text:string, direction:'ida'|'vuelta') {
    try {
      const cfg=teamConfig(), rows=registry();
      const pane=recipient===cfg.lider?lookupPane(rows,cfg.lider):rows[recipient]?.pane_id;
      if(!validPaneId(pane)) {logBell(bellLog,{direction:'vm-turno',task_id:taskId,target:recipient,status:'sin pane registrado'});return;}
      ring(bellLog,taskId,pane,direction,text);
    } catch(e) {logBell(bellLog,{direction:'vm-turno',task_id:taskId,target:recipient,status:'timbre fallido',error:String(e)});}
  }
  async function checkVmTurnExpiry(ctx:ExtensionContext) {
    try {
      const cfg=teamConfig(), id=identity(ctx);
      if(id.owner!==cfg.lider || id.isSubagent || isOfficeBody(ctx.cwd))return;
      const pane=lookupPane(registry(),cfg.lider);
      if(!validPaneId(pane)) {logBell(bellLog,{direction:'vm-turno',task_id:'',target:cfg.lider,status:'sin pane líder; revisar vencimiento'});return;}
      const result=await marcarVencimientoVmTurno(cfg.base,vmTurnRoster());
      if(result.notificar) {
        const holder=result.estado.titular;
        const text=`🔔 Turno VM vencido (NO liberado): ${result.notificar.agente} mantiene el slot para ${result.notificar.task_id}; máximo ${holder?.hasta}. Verificá cualquier CID en vuelo antes de coordinar la liberación.`;
        notifyVmTurn(cfg.lider,result.notificar.task_id,text,'vuelta');
      }
    } catch(e) {logBell(bellLog,{direction:'vm-turno',task_id:'',status:'fallido al comprobar vencimiento',error:String(e)});}
  }
  const api=(ctx:ExtensionContext)=>({get:(path:string)=>get(ctx,path),post:(path:string,body:Record<string,unknown>)=>post(ctx,path,body)});
  /** /task/get de una fila de /task/list, reusando el último si la lista dice el mismo status y assignee. */
  async function officeTaskGet(ctx:ExtensionContext,row:{id:string;status?:string;assignee?:string}) {
    const now=Date.now(),cached=officeTaskDetail.get(row.id);
    if(cached && cached.status===row.status && cached.assignee===row.assignee && now-cached.at<OFFICE_POLL_TTL_MS)return cached.task;
    const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(row.id)}`);
    if(task && task.id===row.id)officeTaskDetail.set(row.id,{status:String(task.status),assignee:String(task.assignee),task,at:now});
    return task;
  }
  const confirmed=(ctx:ExtensionContext,kind:EffectKind,taskId:string,expected:ExpectedEffect={})=>
    confirmarEfecto(api(ctx),kind,taskId,expected);
  const announce=(ctx:ExtensionContext,kind:EffectKind,taskId:string,expected:ExpectedEffect,send:()=>void)=>
    anunciarEfecto(api(ctx),kind,taskId,expected,send);
  const leaderContextDeps=(ctx:ExtensionContext)=>{
    const cfg=teamConfig();
    const rootConfig=join(cfg.base,'equipo.json');
    // coordinator's committed package still owns equipo.json in its package root;
    // new vendored teams keep the config under the team root. Never guess a
    // foreign config: the adapter compares all fields before invoking CLI.
    const teamFile=process.env.PI_OFICINAS_EQUIPO ||
      (existsSync(rootConfig) ? rootConfig : fileURLToPath(new URL('../equipo.json',import.meta.url)));
    return (contextWiring?.buildDeps ?? buildContextRelaunchDeps)({team:cfg,leaderPaneId:process.env.HERDR_PANE_ID || '',teamFile},
      pendingContext,{
        getTask:async taskId=>get(ctx,`/task/get?task_id=${encodeURIComponent(taskId)}`),
        ringTask:async (office,taskId)=>{
          const row=registry()[office] as {pane_id?:string;session?:string}|undefined;
          if(!validPaneId(row?.pane_id)||!row?.session)throw new Error('Oficina sin nuevo sello para timbre');
          queueLeaderBell(leaderQueue,bellLog,{kind:'task-available',direction:'ida',task_id:taskId,
            fingerprint:`context-relaunch:${taskId}:${row.session}`,expected:{office},
            text:`🔔 Tenés la tarea ${taskId} — leela en el tablero`},row.pane_id);
        },
      });
  };
  const persistLeaderPending=()=>writePendingContext(teamConfig().lider_body,pendingContext,[...offices]);
  const contextResult=(result:{status:string;reason?:string},taskId:string)=>
    logBell(bellLog,{direction:'contexto',task_id:taskId,target:teamConfig().lider,status:`relaunch ${result.status}${result.reason?':'+result.reason:''}`});
  async function handleLeaderContext(ctx:ExtensionContext, text:string){
    const request=parseContextNotice(text,[...offices]);
    if(!request)return false;
    const result=await coordinateContextRelaunch(text,leaderContextDeps(ctx));
    contextResult(result,request.taskId);
    if(result.status==='working'||result.status==='relaunched')persistLeaderPending();
    return true;
  }
  const announceContextTask=(ctx:ExtensionContext, office:string, taskId:string, percent:number|null) => {
    const session=ctx.sessionManager.getSessionFile();
    if(!session || (percent!==null && (!Number.isFinite(percent) || percent<70)))throw new Error('Umbral/sesión no verificables');
    const fingerprint=`${session}:${taskId}`;
    if(announcedContext.has(fingerprint))return;
    const cfg=teamConfig();
    const text=formatContextNotice({office,percent:percent===null?null:Math.floor(percent),taskId});
    const leader=lookupPane(registry(),cfg.lider);
    if(!validPaneId(leader))throw new Error('Sin pane líder registrado; mantener tarea pendiente');
    ring(bellLog,taskId,leader,'vuelta',text);
    announcedContext.add(fingerprint);
    logBell(bellLog,{direction:'contexto',task_id:taskId,target:cfg.lider,status:'relanzar solicitado'});
  };
  pi.on('turn_end', (_event,ctx) => {
    try {
      if(!isOfficeBody(ctx.cwd) || teamRole(teamConfig(),ctx.cwd,true,parseEnvFile(ctx.cwd).AGENT_NAME)!=='office')return;
      const snapshot=contextSnapshot(ctx);
      if(!snapshot.sessionFile || !snapshot.sessionId)return;
      persistContextSnapshot(ctx.cwd,snapshot,snapshot.sessionFile);
      const label=snapshot.percent===null?'desconocido':snapshot.percent>=70?String(Math.floor(snapshot.percent)):null;
      if(label && !contextAlerted.has(`${snapshot.sessionFile}:${label==='desconocido'?'unknown':'threshold'}`)){
        contextAlerted.add(`${snapshot.sessionFile}:${label==='desconocido'?'unknown':'threshold'}`);
        logBell(bellLog,{direction:'contexto',task_id:'',target:parseEnvFile(ctx.cwd).AGENT_NAME,status:`alerta ${label}${label==='desconocido'?'':'%'}`});
        if(ctx.hasUI)ctx.ui.notify(`Contexto ${label}${label==='desconocido'?'':'%'}: terminar tarea actual; relanzar antes de la próxima`, 'warning');
      }
    } catch(e) {logBell(bellLog,{direction:'contexto',task_id:'',status:'medición fallida',error:String(e)});}
  });
  async function collectMonitorData(ctx:ExtensionContext, now=Date.now()) {
    const cfg=teamConfig(), settings=secretaryConfig(cfg), rows=registry();
    let herdrBlind:Record<string,HerdrBlindState>={};
    try{const state=readPrivateJson(join(cfg.lider_body,'state','secretaria-vigilancia.json'),{version:1,herdrBlind:{}} as any);
      if(state.herdrBlind&&typeof state.herdrBlind==='object'&&!Array.isArray(state.herdrBlind))herdrBlind=state.herdrBlind;
    }catch{}
    const officeFacts=new Map<string,any>(), report:any[]=[];
    for(const office of offices){
      const registered=rows[office] as {pane_id?:string;session?:string}|undefined;
      let observation:any={state:'unknown'};
      if(validPaneId(registered?.pane_id)){
        try{
          const probe=spawnSync('herdr',['pane','get',registered.pane_id],{encoding:'utf8',timeout:5000,maxBuffer:256*1024});
          let raw:any={};try{raw=JSON.parse(probe.stdout||'{}')}catch{}
          if(probe.status===0||probe.status===1)observation=parsePaneObservation(raw,registered.pane_id,registered.session);
        }catch{}
      }
      const body=join(cfg.base,office),health=collectPaneHealth(observation,body,now);
      const snapshot=observation.sessionFile?readContextSnapshot(body,observation.sessionFile,now,observation.sessionId,
        settings.contexto_ttl_min*60_000):null;
      let taskError:string|undefined;
      const taskRows:any[]=[];
      try{
        for(const status of ['in_progress','blocked','submitted']){
          taskRows.push(...await listOfficeStatus({get: path=>get(ctx,path)},office,status));
        }
      }catch(e){taskError=String(e);}
      const details:any[]=[];
      if(!taskError){
        try{
          for(const candidate of taskRows){
            if(typeof candidate?.id!=='string')throw new Error('tarea sin id');
            const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(candidate.id)}`);
            if(task?.id!==candidate.id||task.assignee!==office||!Array.isArray(task.tags)||!task.tags.includes('oficina'))continue;
            if(['in_progress','blocked','submitted'].includes(task.status))details.push(task);
          }
        }catch(e){taskError=String(e);}
      }
      const active=details.filter(task=>healthTaskEligible(task,office));
      const blocked=details.filter(task=>task.status==='blocked');
      const submitted=details.filter(task=>task.status==='submitted');
      const activeEvents=new Map<string,any[]>();
      for(const task of active){
        try{const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
          if(!Array.isArray(activity?.events))throw new Error('actividad inválida');
          activeEvents.set(task.id,activity.events);
        }catch{activeEvents.set(task.id,[]);}
      }
      const activeSummary=active.map(task=>{
        const events=activeEvents.get(task.id)??[],last=events.at(-1)?.created_at,stamp=typeof last==='string'?Date.parse(last):NaN;
        return {id:task.id,minutesSinceLastEvent:Number.isFinite(stamp)?Math.max(0,(now-stamp)/60_000):null,
          lastEventAt:Number.isFinite(stamp)?last:null};
      });
      const verdict=taskError&&health.pane!=='missing'?'DESCONOCIDO':monitorVerdict({pane:health.pane,
        hasActiveTask:active.length>0,hasBlockedTask:blocked.length>0,hasSubmittedTask:submitted.length>0,
        backgroundRunning:health.backgroundRunning,writeAgeMinutes:health.writeAgeMinutes,stopClass:health.stopClass},settings.pegada_min,settings.parada_min);
      const context={percent:snapshot?.percent??null,tokens:snapshot?.tokens??null,contextWindow:snapshot?.contextWindow??null,
        ageMinutes:snapshot?Math.max(0,(now-snapshot.observedAt)/60_000):null,status:snapshot&&snapshot.percent!==null?'medido':'desconocido'};
      const herdrBlindCurrent=['idle','done'].includes(health.pane)&&health.writeAgeMinutes!==undefined&&
        health.writeAgeMinutes<settings.parada_min&&herdrBlind[office]?.count>=2;
      const row={office,pane:health.pane,activeTasks:activeSummary,blockedTasks:blocked.map(t=>({id:t.id,reason:typeof t.blocked_reason==='string'?t.blocked_reason:null})),
        submittedTasks:submitted.map(t=>({id:t.id})),minutesSinceSessionWrite:health.writeAgeMinutes??null,
        sessionStopReason:health.stopReason,backgroundTasks:health.backgroundRunning,context,
        ...(observation.sessionMismatch?{sessionMismatch:true,registrySession:observation.registrySession,activeSession:observation.sessionFile}:{}),
        verdict,...(herdrBlindCurrent?{herdr_ciego:true,herdr_ciego_sweeps:herdrBlind[office].count}:{}),
        ...(taskError?{taskReadError:'no se pudo verificar la lista/actividad de tareas'}:{})};
      report.push(row);
      officeFacts.set(office,{office,observation,health,active,blocked,submitted,activeEvents,taskError,snapshot,row});
    }
    const cfgLeaderPane=lookupPane(rows,cfg.lider),leaderObservation=validPaneId(cfgLeaderPane)?(()=>{
      try{const probe=spawnSync('herdr',['pane','get',cfgLeaderPane],{encoding:'utf8',timeout:5000,maxBuffer:256*1024});
        let raw:any={};try{raw=JSON.parse(probe.stdout||'{}')}catch{}
        return probe.status===0||probe.status===1?parsePaneObservation(raw,cfgLeaderPane):{state:'unknown'};
      }catch{return {state:'unknown'};}
    })():{state:'unknown'};
    const leaderUsage=contextSnapshot(ctx,now);
    report.push({office:cfg.lider,leader:true,pane:leaderObservation.state,context:{percent:leaderUsage.percent,tokens:leaderUsage.tokens,
      contextWindow:leaderUsage.contextWindow,ageMinutes:0,status:leaderUsage.percent===null?'desconocido':'medido'},verdict:leaderObservation.state==='working'?'TRABAJANDO':
      leaderObservation.state==='idle'||leaderObservation.state==='done'?'LIBRE':leaderObservation.state==='missing'?'CAÍDA':'DESCONOCIDO'});
    return {report,officeFacts,registry:rows};
  }
  const correspondenceLedgerPath=join(teamConfig().lider_body,'state','secretaria-correspondencia-v2.jsonl');
  const correspondenceInboxPath='/correspondencia/bandeja?archivo=false&incluir_contenido=false';
  const correspondenceHealthPath=join(teamConfig().lider_body,'state','secretaria-correspondencia-f4-health.json');
  function wellFormedHealth(value:unknown):value is {streak:number;alerted:boolean} {
    return !!value&&typeof value==='object'&&Number.isInteger((value as any).streak)&&(value as any).streak>=0&&
      typeof (value as any).alerted==='boolean';
  }
  /** Lee el estado de racha F4; si el archivo es inseguro/malformado/corrupto, lo pone en
   *  cuarentena (se MUEVE a .trash, nunca se borra) UNA sola vez — la próxima lectura ya
   *  no lo encuentra y usa el default silenciosamente, sin generar un aviso cada barrido —
   *  y devuelve el default fresco {streak:0,alerted:false} para que la racha SIGA contando
   *  en vez de congelarse para siempre (el fallo silencioso que esta tarea tiene que matar).
   */
  function readCorrespondenceHealth():{streak:number;alerted:boolean} {
    const fallback={streak:0,alerted:false};
    let raw:unknown;
    try{raw=readPrivateJson<unknown>(correspondenceHealthPath,fallback);}
    catch(e){
      const parked=quarantineUnsafeFile(correspondenceHealthPath);
      logBell(bellLog,{direction:'correspondencia',task_id:'',
        status:parked?'estado de racha F4 inseguro/corrupto; cuarentena y racha en 0':'estado de racha F4 inseguro/corrupto',error:String(e)});
      return fallback;
    }
    if(raw===fallback)return fallback; // ENOENT: no hay archivo que poner en cuarentena.
    if(!wellFormedHealth(raw)){
      const parked=quarantineUnsafeFile(correspondenceHealthPath);
      logBell(bellLog,{direction:'correspondencia',task_id:'',
        status:parked?'estado de racha F4 con forma inválida; cuarentena y racha en 0':'estado de racha F4 con forma inválida'});
      return fallback;
    }
    return raw;
  }
  async function pollCorrespondence(ctx:ExtensionContext) {
    if(correspondencePolling)return;
    correspondencePolling=true;
    const cfg=teamConfig(),settings=secretaryConfig(cfg);
    try{
      const id=identity(ctx);if(!settings.correo||id.owner!==cfg.lider||id.isSubagent||isOfficeBody(ctx.cwd))return;
      let ledger:CorrespondenceLedgerRow[]=[];
      try{ledger=readPrivateJsonLines(correspondenceLedgerPath) as CorrespondenceLedgerRow[];}
      catch(e){
        if(existsSync(correspondenceLedgerPath))quarantinePrivateFile(correspondenceLedgerPath);
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'ledger F4 corrupto; cuarentena y línea base nueva',error:String(e)});
        ledger=[];
      }
      const kinds=new Set(['baseline','incoming_baseline_seen','source_event','source_done','notice_pending','notice_sent','notice_capped','notice_timeout_capped',
        'notice_uncertain','notice_reserved_elsewhere','notice_reservation_alerted','incoming_queued','incoming_capped','notice_acked','notice_rejected','notice_delivered','notice_timeout',
        'incoming_batched','incoming_low','incoming_batch_sent']);
      if(ledger.some(row=>!row||!kinds.has(row.kind)||(row.at!==undefined&&typeof row.at!=='string'))){
        if(existsSync(correspondenceLedgerPath))quarantinePrivateFile(correspondenceLedgerPath);
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'ledger F4 malformado; cuarentena y línea base nueva'});ledger=[];
      }
      // F5 (a82e464f): bounded ledger. Past 1 MB it is compacted keeping the baseline and the
      // last 14 days (atomic rewrite 0600; the previous copy goes to .trash, bounded).
      try{
        if(existsSync(correspondenceLedgerPath)&&statSync(correspondenceLedgerPath).size>JSONL_MAX_BYTES){
          ledger=compactCorrespondenceLedger(ledger,Date.now());rewritePrivateJsonLines(correspondenceLedgerPath,ledger);
          logBell(bellLog,{direction:'correspondencia',task_id:'',status:`ledger F4 compactado (${ledger.length} filas)`});
        }
      }catch(e){logBell(bellLog,{direction:'correspondencia',task_id:'',status:'compactación ledger F4 fallida',error:String(e)});}
      const record=(entry:Record<string,unknown>)=>appendPrivateJsonLine(correspondenceLedgerPath,entry);
      const reloadCorrespondenceLedger=()=>{
        const current=readPrivateJsonLines(correspondenceLedgerPath) as CorrespondenceLedgerRow[];
        if(current.some(row=>!row||!kinds.has(row.kind)||(row.at!==undefined&&typeof row.at!=='string')))
          throw new Error('Ledger Correspondencia cambió a un estado no válido; fail closed');
        return current;
      };
      const api={get:(path:string)=>get(ctx,path),post:(path:string,body:Record<string,unknown>)=>post(ctx,path,body)};
      const registryResolution=await resolveLeaderNames(join(cfg.lider_body,'state'),()=>get(ctx,'/agents/registry',LEADER_REGISTRY_TIMEOUT_MS));
      if(registryResolution.fetchError)logBell(bellLog,{direction:'correspondencia',task_id:'',
        status:registryResolution.source==='last-good'?'registro de líderes fresco falló; usando último-bueno':'registro de líderes fresco falló',
        error:registryResolution.fetchError});
      const leaderNames=registryResolution.leaders;
      if(!leaderNames)throw new Error('Registro de líderes Correspondencia inválido; no timbrar');
      let baselineMarkers=ledger.filter(row=>row.kind==='baseline');
      let baselineAt=baselineMarkers.length===1?Date.parse(String(baselineMarkers[0].activatedAt??'')):NaN;
      if(baselineMarkers.length>1||(baselineMarkers.length===1&&!Number.isFinite(baselineAt))){
        if(existsSync(correspondenceLedgerPath))quarantinePrivateFile(correspondenceLedgerPath);
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'baseline F4 ambiguo; cuarentena y línea base nueva'});
        ledger=[];baselineMarkers=[];baselineAt=NaN;
      }
      const baselineCandidateAt=Date.now(),currentInbox=await get(ctx,correspondenceInboxPath);
      if(baselineMarkers.length===0){
        baselineAt=baselineCandidateAt;const entry={kind:'baseline',activatedAt:new Date(baselineAt).toISOString(),at:new Date().toISOString()};
        record(entry);ledger.push(entry);
      }
      const baselineCodes=coldStartSeenCodes(currentInbox,cfg.lider,baselineAt);
      if(!baselineCodes)throw new Error('No se pudo crear la línea base de Correspondencia; no timbrar');
      const baselineSeen=new Set<string>(ledger.filter(row=>row.kind==='incoming_baseline_seen')
        .flatMap(row=>Array.isArray(row.codes)?row.codes:(typeof row.codigo==='string'?[row.codigo]:[])));
      const missingBaseline=baselineCodes.filter(code=>!baselineSeen.has(code));
      if(missingBaseline.length){
        const entry={kind:'incoming_baseline_seen',codes:missingBaseline,activatedAt:new Date(baselineAt).toISOString(),at:new Date().toISOString()};
        record(entry);ledger.push(entry);
      }
      const rows=registry(),leaderPane=lookupPane(rows,cfg.lider);
      const leaderIdle=()=>validPaneId(leaderPane)&&observePaneQuiet(leaderPane).state==='idle';
      const completedSources=new Set(ledger.filter(row=>row.kind==='source_done').map(row=>row.sourceId).filter((x):x is string=>typeof x==='string'));
      for(const source of ledger.filter(row=>row.kind==='source_event'&&typeof row.sourceId==='string'&&!completedSources.has(row.sourceId))){
        const intent={toolName:String(source.toolName??''),input:source.input??{},output:source.output??{}};
        const result=await emitSecretarialNotices(api,cfg.lider,intent,ledger,
          {daily:settings.correo_tope_diario,hourly:settings.correo_tope_hora},Date.now(),leaderIdle,record,cfg.oficinas,
          async name=>leaderNames.has(name),{stateDirectory:join(cfg.lider_body,'state'),confirmMin:settings.confirmacion_min,
            reloadLedger:reloadCorrespondenceLedger,onIdentityUncertain:alert=>{
              const text=`Reserva de Correspondencia ${alert.original} para @${alert.destination} sin identidad de proceso verificable tras ${alert.confirmMin*3} min; el envío es incierto y no se reintenta a ciegas. Revisión requerida.`;
              const notice:LeaderNotice={kind:'correspondence-reservation-uncertain',direction:'vuelta',task_id:alert.original,
                fingerprint:`correspondencia-reservation-uncertain:${alert.original}:${alert.destination}`,
                expected:{leader:cfg.lider,original:alert.original,destination:alert.destination,reason:alert.reason,confirmMin:alert.confirmMin},text};
              queueLeaderBell(leaderQueue,bellLog,notice,validPaneId(leaderPane)?leaderPane:undefined);
            }});
        if(result.status!=='pending-pane'&&result.status!=='unverified'&&result.status!=='reserved'&&!result.reserved)
          record({kind:'source_done',sourceId:source.sourceId,status:result.status,at:new Date().toISOString()});
      }
      await processIncomingCorrespondence(api,cfg.lider,ledger,
        {daily:settings.correo_tope_diario,hourly:settings.correo_tope_hora,fallback:settings.correo_respaldo},Date.now(),candidate=>{
          if(!validPaneId(leaderPane))return false;
          const notice:LeaderNotice={kind:'correspondence-received',direction:'vuelta',task_id:candidate.codigo,
            fingerprint:`correspondencia-in:${candidate.codigo}`,expected:{leader:cfg.lider,originalCode:candidate.codigo,remitente:candidate.remitente,priority:candidate.prioridad},
            text:formatIncomingBell(candidate)};
          // Despachar al instante desde la cola durable. El worker espera en slices cortos
          // a que el pane quede libre; no interrumpe el turno ni depende del próximo sweep.
          queueLeaderBell(leaderQueue,bellLog,notice,leaderPane,spawn,true);return true;
        },record,leaderNames);
        queueLeaderBell(leaderQueue,bellLog,null,undefined); // revive pending notices on every 2-minute F4 poll, not only the 5-minute sweep
      // 277eb7cf: lote de medios. A lo sumo UN timbre cada correo_lote_medios_min, y NUNCA
      // mientras the human está conversando (último mensaje de usuario real hace menos de
      // correo_silencio_humano_min). Un urgente nunca espera a este lote (sale solo arriba).
      {
        const pendingMedium=pendingBatchedMedium(ledger);
        if(pendingMedium.length&&validPaneId(leaderPane)){
          const humanActive=humanRecentlyActive(ctx.sessionManager.getBranch(),Date.now(),settings.correo_silencio_humano_min);
          if(shouldSendBatch(ledger,Date.now(),settings.correo_lote_medios_min,humanActive)){
            const lowCount=pendingLowCount(ledger);
            const text=formatBatchedBell(pendingMedium,lowCount);
            const codes=pendingMedium.map(row=>row.codigo);
            const lowCodes=ledger.filter(row=>row.kind==='incoming_low'&&typeof row.codigo==='string').map(row=>row.codigo!);
            const notice:LeaderNotice={kind:'correspondence-batch',direction:'vuelta',task_id:codes[0]??'',
              fingerprint:`correspondencia-lote:${codes.join(',')}:${Date.now()}`,
              expected:{leader:cfg.lider,codes},text};
            queueLeaderBell(leaderQueue,bellLog,notice,leaderPane);
            record({kind:'incoming_batch_sent',codes,lowCodes,at:new Date().toISOString()});
          }
        }
      }
      const latestInbox=await get(ctx,correspondenceInboxPath);
      const acknowledgement=checkSecretarialAcknowledgements(latestInbox,cfg.lider,ledger,Date.now(),settings.confirmacion_min);
      for(const item of acknowledgement.delivered){
        const already=ledger.some(row=>row.kind==='notice_delivered'&&row.original===item.original&&row.destination===item.destination);
        if(already)continue;
        record({kind:'notice_delivered',original:item.original,destination:item.destination,latencyMinutes:item.latencyMinutes,at:new Date().toISOString()});
        logBell(bellLog,{direction:'correspondencia',task_id:item.original,target:item.destination,
          status:`entregado ack=${item.latencyMinutes.toFixed(1)} min`});
      }
      let f4DayUsed=f4WindowCount(ledger,'day',Date.now()),f4HourUsed=f4WindowCount(ledger,'hour',Date.now());
      for(const item of acknowledgement.timeouts){
        if(ledger.some(row=>row.kind==='notice_timeout'&&row.noticeCode===item.noticeCode)||
           ledger.some(row=>row.kind==='notice_timeout_capped'&&row.noticeCode===item.noticeCode))continue;
        const sent=ledger.find(row=>row.kind==='notice_sent'&&row.noticeCode===item.noticeCode);
        if(!sent||!validPaneId(leaderPane))continue;
        const now=Date.now();
        if(f4DayUsed>=settings.correo_tope_diario||f4HourUsed>=settings.correo_tope_hora){
          record({kind:'notice_timeout_capped',noticeCode:item.noticeCode,original:item.original,destination:item.destination,
            day:new Date(now).toISOString().slice(0,10),hour:new Date(now).toISOString().slice(0,13),at:new Date(now).toISOString()});
          f4DayUsed++;f4HourUsed++;
          logBell(bellLog,{direction:'correspondencia',task_id:item.original,target:item.destination,status:'tope correo/hora agotado; timeout no timbrado'});
          continue;
        }
        const text=formatSenderTimeout(item.destination,item.original,settings.confirmacion_min);
        const notice:LeaderNotice={kind:'correspondence-timeout',direction:'vuelta',task_id:item.original,
          fingerprint:`correspondencia-timeout:${item.noticeCode}`,expected:{leader:cfg.lider,noticeCode:item.noticeCode,
            original:item.original,destination:item.destination,minutes:settings.confirmacion_min,sentAt:sent.at},text};
        queueLeaderBell(leaderQueue,bellLog,notice,leaderPane);
        record({kind:'notice_timeout',noticeCode:item.noticeCode,original:item.original,destination:item.destination,
          day:new Date(now).toISOString().slice(0,10),hour:new Date(now).toISOString().slice(0,13),at:new Date(now).toISOString()});
        f4DayUsed++;f4HourUsed++;
      }
      try{
        const health=readCorrespondenceHealth();
        if(health.streak!==0||health.alerted!==false)writePrivateJson(correspondenceHealthPath,{streak:0,alerted:false});
      }catch(healthError){
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'racha F4 no restablecida',error:String(healthError)});
      }
    }catch(e){
      logBell(bellLog,{direction:'correspondencia',task_id:'',status:'barrido F4 fallido',error:String(e)});
      try{
        const threshold=settings.correo_racha_fallo;
        const health=readCorrespondenceHealth();
        const streak=health.streak+1;
        const alerted=health.alerted===true;
        writePrivateJson(correspondenceHealthPath,{streak,alerted:alerted||streak>=threshold});
        if(!alerted&&streak>=threshold)
          pi.sendUserMessage(`🔔 Correspondencia (F4): el barrido viene fallando hace ${streak} ${streak===1?'vuelta':'vueltas'} seguidas (${String(e)}) — es un fallo PERMANENTE, no uno transitorio; revisá el log y la causa de fondo`);
      }catch(healthError){
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'racha F4 no registrable',error:String(healthError)});
      }
    }
    finally{correspondencePolling=false;}
  }
  async function sweep(ctx:ExtensionContext) {
    if(sweeping)return;
    sweeping=true;
    try {
      const id=identity(ctx);
      if(id.owner!==teamConfig().lider || id.isSubagent)return;
      const api={get:(path:string)=>get(ctx,path),post:(path:string,body:Record<string,unknown>)=>post(ctx,path,body)};
      const rows=registry(),cfg=teamConfig(),settings=secretaryConfig(cfg),now=Date.now();
      const monitorData=(settings.avisos||settings.contexto)?await collectMonitorData(ctx,now):undefined;
      const probePane=(task:any)=>{
        const fact=monitorData?.officeFacts.get(task.assignee);
        if(fact){
          if(fact.health.pane==='working')logBell(bellLog,{direction:'barrido',task_id:task.id,target:task.assignee,status:'working'});
          else if(fact.health.pane==='unknown')logBell(bellLog,{direction:'barrido',task_id:task.id,target:task.assignee,status:'estado desconocido'});
          return {state:fact.health.pane==='done'?'idle':fact.health.pane,lastSessionWriteAt:fact.health.lastWriteAt};
        }
        const registered=rows[task.assignee] as {pane_id?:string;session?:string}|undefined;
        let observation:any={state:'unknown'};
        if(validPaneId(registered?.pane_id))try{
          const result=spawnSync('herdr',['pane','get',registered.pane_id],{encoding:'utf8',timeout:5000,maxBuffer:256*1024});
          let raw:any={};try{raw=JSON.parse(result.stdout||'{}')}catch{}
          if(result.status===0||result.status===1)observation=parsePaneObservation(raw,registered.pane_id,registered.session);
        }catch{}
        const health=collectPaneHealth(observation,join(cfg.base,task.assignee),now);
        if(health.pane==='working')logBell(bellLog,{direction:'barrido',task_id:task.id,target:task.assignee,status:'working'});
        else if(health.pane==='unknown')logBell(bellLog,{direction:'barrido',task_id:task.id,target:task.assignee,status:'estado desconocido'});
        return {state:health.pane==='done'?'idle':health.pane,lastSessionWriteAt:health.lastWriteAt};
      };
      let candidates=await leaderSweep(api,offices,now,settings.quiet_min*60_000,probePane);
      const alerts:LeaderNotice[]=[],newLeaderNotices:LeaderNotice[]=[];
      let vigilanceState:any;
      if((settings.avisos||settings.contexto)&&monitorData){
        try{
          const vigilancePath=join(cfg.lider_body,'state','secretaria-vigilancia.json');
          vigilanceState=readPrivateJson(vigilancePath,{version:1,health:{},contextSeen:[]});
          if(vigilanceState?.version!==1||!vigilanceState.health||typeof vigilanceState.health!=='object'||Array.isArray(vigilanceState.health)||
             !Array.isArray(vigilanceState.contextSeen)||vigilanceState.contextSeen.some((value:any)=>typeof value!=='string'))
            throw new Error('Estado de vigilancia inválido; no generar avisos nuevos');
          if(!vigilanceState.herdrBlind||typeof vigilanceState.herdrBlind!=='object'||Array.isArray(vigilanceState.herdrBlind))vigilanceState.herdrBlind={};
          for(const fact of monitorData.officeFacts.values()){
            vigilanceState.herdrBlind[fact.office]=observeHerdrBlind(fact.health.pane,fact.health.writeAgeMinutes,
              fact.observation.sessionFile,now,vigilanceState.herdrBlind[fact.office],settings.parada_min);
          }
          if(settings.avisos)for(const fact of monitorData.officeFacts.values()){
            const active=fact.active.filter((task:any)=>healthTaskEligible(task,fact.office));
            for(const task of active){
              const key=`${fact.office}:${task.id}`,prior=vigilanceState.health[key] as TaskDetectorState|undefined;
              const detected=detectTaskHealth({office:fact.office,taskId:task.id,claimOwner:task.claimed_by??null,
                pane:fact.health.pane,now,sessionMtime:fact.health.lastWriteAt??null,writeAgeMinutes:fact.health.writeAgeMinutes??null,
                stopClass:fact.health.stopClass,backgroundRunning:fact.health.backgroundRunning},prior,
                {paradaMin:settings.parada_min,pegadaMin:settings.pegada_min,cooldownMin:settings.reentrada_cooldown_min,graceMin:settings.gracia_min});
              vigilanceState.health[key]=detected.state;
              for(const action of detected.actions){
                if(action.kind==='leader')newLeaderNotices.push({kind:'health-alert',task_id:task.id,
                  fingerprint:action.fingerprint,expected:{office:fact.office},text:action.text});
                else{
                  const pane=rows[fact.office]?.pane_id;
                  const notice:LeaderNotice={kind:'health-reentry',direction:'ida',task_id:task.id,fingerprint:action.fingerprint,
                    expected:action.expected??{office:fact.office},text:action.text};
                  queueLeaderBell(leaderQueue,bellLog,notice,validPaneId(pane)?pane:undefined);
                }
              }
            }
          }
          if(settings.contexto){
            const seenContext=new Set<string>(vigilanceState.contextSeen);
            for(const fact of monitorData.officeFacts.values()){
              const session=fact.observation.sessionFile,snapshot=fact.snapshot;
              if(!session||!snapshot)continue;
              const alertsForContext=contextAlerts(fact.office,session,snapshot.percent,
                fact.active[0]?.id??null,settings.contexto_aviso,seenContext);
              for(const alert of alertsForContext){newLeaderNotices.push({kind:'health-alert',task_id:fact.active[0]?.id??'',
                fingerprint:alert.fingerprint,expected:{office:fact.office,threshold:alert.threshold},text:alert.text});seenContext.add(alert.fingerprint);}
            }
            vigilanceState.contextSeen=[...seenContext].slice(-5000);
          }
          candidates=candidates.filter(n=>{
            if(n.kind!=='quiet'||!settings.avisos)return true;
            const fact=[...monitorData.officeFacts.values()].find((row:any)=>row.active.some((task:any)=>task.id===n.task_id));
            const already=fact?vigilanceState.health?.[`${fact.office}:${n.task_id}`]:undefined;
            return !(fact&&['idle','done'].includes(fact.health.pane)&&fact.health.lastWriteAt!==undefined&&
              already?.reentryMtime===fact.health.lastWriteAt);
          });
          writePrivateJson(vigilancePath,vigilanceState);
        }catch(e){vigilanceState=undefined;newLeaderNotices.length=0;
          logBell(bellLog,{direction:'barrido',task_id:'',status:'vigilancia/contexto fallido',error:String(e)});}
      }
      for(const n of candidates) {
        const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(n.task_id)}`);
        const suffix=n.fingerprint.slice(n.fingerprint.indexOf(n.task_id)+n.task_id.length+1);
        const kind=n.kind==='question'?'question':n.kind==='block'?'block':n.kind==='dependency'?'dependency':'quiet';
        await announce(ctx,kind,n.task_id,{office:task.assignee,
          ...(kind==='question'?{id:suffix,unanswered:true}:{}),...(kind==='block'?{at:suffix}:{}),
          ...(kind==='quiet'?{now:Date.now(),paneState:n.paneState}: {})},()=>alerts.push(n));
      }
      for(const n of alerts) if(n.kind==='quiet' && n.paneState==='unknown'){
        const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(n.task_id)}`);
        if(!validPaneId(rows[task.assignee]?.pane_id))n.text+='; sin pane registrado: revisión supervisada';
      }
      queueLeaderBell(leaderQueue,bellLog,null,undefined); // revive dispatcher tras un timbre perdido
      const seen=existsSync(leaderSeenPath)?JSON.parse(readFileSync(leaderSeenPath,'utf8')):[];
      if(!Array.isArray(seen)) throw new Error('Barrido: dedupe líder corrupto; NO ignorar hechos');
      const queuedSent=new Set(existsSync(leaderQueue+'.sent')?readFileSync(leaderQueue+'.sent','utf8').split('\n').filter(Boolean):[]);
      const fresh=alerts.filter(n=>!seen.includes(n.fingerprint) && !queuedSent.has(n.fingerprint));
      // Keep the legacy >=70 sweep when the v-next context switch is absent/off.
      // With it enabled, contextAlerts above is session-scoped and TTL-gated.
      const contextLines:string[]=[];
      if(!settings.contexto)for(const office of offices){
        const session=(rows[office] as {session?:string}|undefined)?.session;
        if(typeof session!=='string')continue;
        const snapshot=readContextSnapshot(join(teamConfig().base,office),session);
        if(!snapshot || (snapshot.percent!==null && snapshot.percent<70))continue;
        const descriptor=snapshot.percent===null?'uso desconocido':`${Math.floor(snapshot.percent)}%`;
        contextLines.push(snapshot.percent===null
          ?`${office}: uso de contexto desconocido; relanzar antes de próxima tarea`
          :`${office} al ${descriptor} de contexto; relanzar antes de próxima tarea`);
        logBell(bellLog,{direction:'contexto',task_id:'',target:office,status:`barrido ${descriptor}`});
      }
      if(contextLines.length)pi.sendUserMessage(`🔔 Oficinas contexto >=70% o desconocido:\n${contextLines.join('\n')}`);
      if(newLeaderNotices.length)pi.sendUserMessage(`🔔 Vigilancia de oficinas:\n${newLeaderNotices.map(n=>n.text).join('\n')}`);
      if(pendingContext.size){
        try {
          const keys=[...pendingContext.keys()];
          const results=await retryPendingContextRelaunch(leaderContextDeps(ctx));
          let changed=false;
          for(let i=0;i<results.length;i++){
            const result=results[i],key=keys[i];
            contextResult(result,key.slice(key.indexOf(':')+1));
            if(result.status==='relaunched' || (result.status==='ignored' &&
                ['task','snapshot','registry'].includes(result.reason))){pendingContext.delete(key);changed=true;}
          }
          if(changed)persistLeaderPending();
        }catch(e){logBell(bellLog,{direction:'contexto',task_id:'',status:'retry fallido',error:String(e)});}
      }
      if(!fresh.length) return;
      // One grouped message, question/block before delivery; never include body text.
      pi.sendUserMessage('🔔 Oficinas: revisá el tablero\n'+fresh.map(n=>n.text).join('\n'));
      mkdirSync(dirname(leaderQueue),{recursive:true});
      appendFileSync(leaderQueue+'.sent',fresh.map(n=>n.fingerprint).join('\n')+'\n');
      for(const n of fresh) if(n.kind==='dependency') {
        const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(n.task_id)}`);
        await announce(ctx,'dependency',task.id,{office:task.assignee},()=>
          queueLeaderBell(leaderQueue,bellLog,{kind:'dependency',task_id:task.id,direction:'ida',
            fingerprint:`dependency-ida:${n.fingerprint}`,expected:{office:task.assignee},
            text:dependencyNotice(task.id).text},
            registry()[task.assignee]?.pane_id));
      }
      mkdirSync(join(process.cwd(),'state'),{recursive:true});
      writeFileSync(leaderSeenPath,JSON.stringify([...new Set([...seen,...fresh.map(n=>n.fingerprint)])])+'\n');
    } catch(e) {logBell(bellLog,{direction:'barrido',task_id:'',status:'fallido',error:String(e)});}
    finally {sweeping=false;}
  }
  let scanning = false;
  let mode: 'writer' | 'read-only' = 'read-only';
  let probedAtGate = false;
  async function probe(ctx: ExtensionContext, office: string) {
    try {
      const id = identity(ctx);
      if (id.owner !== office || !id.isSubagent) throw new Error('Identidad ajena a oficina');
      const { response } = await timedFetch(cerebroBase(ctx), '/task/claim', {
        method: 'POST', headers: {[AUTH_HEADER]: id.key, 'Content-Type':'application/json'},
        body: JSON.stringify({task_id:'00000000-0000-0000-0000-000000000000'}),
      }, 15_000);
      mode = deliveryMode(response.status);
      logBell(bellLog, {direction:'clase', task_id:'', target:office, status:mode,
        ...(response.status !== 403 && response.status !== 404 ? {error:`HTTP ${response.status}`} : {})});
    } catch(e) {
      mode = 'read-only';
      logBell(bellLog, {direction:'clase', task_id:'', target:office, status:'read-only', error:String(e)});
    }
  }
  pi.on('session_start', (_event, ctx) => {
    pendingEffects.clear();
    if (timer) clearInterval(timer);
    if (leaderTimer) clearInterval(leaderTimer);
    if (vmTurnTimer) clearInterval(vmTurnTimer);
    if (correspondenceTimer) clearInterval(correspondenceTimer);
    probedAtGate = false;
    mode = 'read-only';
    const office = isOfficeBody(ctx.cwd) ? parseEnvFile(ctx.cwd).AGENT_NAME : undefined;
    if(!office) {
      if(leaderTimer) clearInterval(leaderTimer);
      // Deliberately no timer in a mini: only the keyed leader may sweep.
      try {if(identity(ctx).owner===teamConfig().lider && !identity(ctx).isSubagent) {
        pendingContext.clear();
        for(const [key,request] of readPendingContext(ctx.cwd,[...offices]))pendingContext.set(key,request);
        void sweep(ctx);
        leaderTimer=setInterval(()=>void sweep(ctx),5*60_000);leaderTimer.unref();
        const settings=secretaryConfig(teamConfig());
        if(settings.correo){
          void pollCorrespondence(ctx);
          correspondenceTimer=setInterval(()=>void pollCorrespondence(ctx),settings.correo_cada_min*60_000);
          correspondenceTimer.unref();
        }
        void checkVmTurnExpiry(ctx);
        vmTurnTimer=setInterval(()=>void checkVmTurnExpiry(ctx),30_000);vmTurnTimer.unref();
      }} catch(e) {logBell(bellLog,{direction:'barrido',task_id:'',status:'fallido',error:String(e)});}
      return;
    }
    try { startCostSession(ctx,ctx.cwd); }
    catch(e) { logBell(bellLog,{direction:'costo',task_id:'',status:'fallido',error:String(e)}); }
    timer = setInterval(async () => {
      // No backlog ni sonda antes del gate verificado por toolResult.
      if (!existsSync(join(ctx.cwd, 'state', 'secretaria-gate-ok'))) return;
      if (!probedAtGate) { probedAtGate = true; await probe(ctx, office); }
      if (scanning || !ctx.isIdle()) return;
      scanning = true;
      try {
        const id = identity(ctx);
        if (id.owner !== office || !id.isSubagent) throw new Error('Tag no coincide con oficina');
        // UNA lista por ciclo (98bf4465). Con 500 filas no hay garantía de completitud: se vuelve
        // al camino anterior (una lista por status), que falla cerrado igual que antes.
        const listed = await get(ctx, `/task/list?assignee=${encodeURIComponent(office)}&limit=500`);
        const allRows = Array.isArray(listed) ? listed : listed?.tasks;
        if (!Array.isArray(allRows) || !ctx.isIdle()) return;
        const complete = allRows.length < 500;
        let items: any[];
        if (complete) items = allRows.filter((row:any) => row?.status === 'todo');
        else {
          const data = await get(ctx, `/task/list?status=todo&assignee=${encodeURIComponent(office)}&limit=500`);
          items = Array.isArray(data) ? data : data?.tasks;
          if (!Array.isArray(items) || !ctx.isIdle()) return;
        }
        const bandejaSeenFile=join(ctx.cwd,'state','secretaria-bandeja.json');
        const bandejaSeen=existsSync(bandejaSeenFile)?JSON.parse(readFileSync(bandejaSeenFile,'utf8')):[];
        if(!Array.isArray(bandejaSeen))throw new Error('Dedupe bandeja corrupto');
        // Una tarea ya timbrada nunca se vuelve a timbrar (unseenIds la descarta): no hace falta
        // pedir su detalle ni confirmarla en cada ciclo.
        const pendingItems = items.filter((row:any) => !bandejaSeen.includes(row?.id));
        const rowById = new Map(pendingItems.map((row:any) => [row.id, row]));
        // /task/list omits tags: only /task/get has authoritative tag membership.
        const tagged = await taggedCandidates(pendingItems, office, id => officeTaskGet(ctx, rowById.get(id) ?? {id}));
        if (!ctx.isIdle()) return;
        const ready=[];
        for(const task of tagged) if(await confirmed(ctx,'task-available',task.id,{office})) ready.push(task);
        const verified=orderReadyTasks(ready);
        const next=verified.find(task=>task.status==='todo' && task.assignee===office && !bandejaSeen.includes(task.id));
        const snapshot=contextSnapshot(ctx);
        if(next && shouldDeferNewTask(snapshot,'todo')){
          if(snapshot.sessionFile && snapshot.sessionId){
            persistContextSnapshot(ctx.cwd,snapshot,snapshot.sessionFile);
            announceContextTask(ctx,office,next.id,snapshot.percent);
          } else logBell(bellLog,{direction:'contexto',task_id:next.id,target:office,status:'sesión sin ancla; bandeja diferida'});
          return; // unseenIds must NOT mark this task delivered before relaunch.
        }
        for (const taskId of unseenIds(bandejaSeenFile, verified, office, taskId => {
          if (!ctx.isIdle()) throw new Error('Oficina ocupada: reintentar próximo ciclo');
          void probe(ctx, office); // nueva tarea: sonda sin mutación, no en cada tick
          pi.sendUserMessage(`🔔 (bandeja) Tenés la tarea ${taskId}: leela con cb_task_get y trabajala según tu ficha`);
        })) {
          logBell(bellLog, {direction:'bandeja', task_id:taskId, target:office, status:'recibido'});
        }
        // Lost leader->office answer bells: recover by the same paper, never by repeating body text.
        const activeRows:any[]=complete?allRows.filter((row:any)=>['todo','in_progress','blocked'].includes(row?.status)):[];
        if(!complete) for(const status of ['todo','in_progress','blocked']) {
          const active=await get(ctx,`/task/list?status=${status}&assignee=${encodeURIComponent(office)}&limit=500`);
          const rows=Array.isArray(active)?active:active?.tasks;
          if(!Array.isArray(rows) || rows.length===500) throw new Error('Bandeja respuestas incompleta');
          activeRows.push(...rows);
        }
        const seenFile=join(ctx.cwd,'state','secretaria-respuestas-seen.json');
        const seen=existsSync(seenFile)?JSON.parse(readFileSync(seenFile,'utf8')):[];
        if(!Array.isArray(seen)) throw new Error('Dedupe respuestas corrupto');
        for(const row of new Map(activeRows.map(r=>[r.id,r])).values()) {
          if(!ctx.isIdle() || row.assignee!==office)break;
          const task=await officeTaskGet(ctx,row);
          if(task.assignee!==office || !Array.isArray(task.tags) || !task.tags.includes('oficina'))continue;
          // Sin pregunta propia abierta no puede llegar una respuesta: no se relee la actividad
          // hasta que cambie el status, pase el TTL o esta misma oficina pregunte (oficina_preguntar
          // invalida la entrada).
          const nowMs=Date.now(),lastActivity=officeActivityState.get(task.id);
          if(lastActivity && lastActivity.status===task.status && !lastActivity.open && nowMs-lastActivity.at<OFFICE_POLL_TTL_MS)continue;
          const census=task.status==='blocked'?await dependencyCensus(api(ctx),task.id):null;
          if(task.status==='blocked' && (!census || census.pendingCount===0)){
            officeActivityState.set(task.id,{status:String(task.status),open:false,at:nowMs});continue;
          }
          const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
          const state=questionState(activity.events ?? []);
          // «Abierta» = pregunta propia sin respuesta, o con respuesta todavía no anunciada.
          const markActivity=()=>officeActivityState.set(task.id,{status:String(task.status),at:nowMs,
            open:[...state.questions].some(([qid,event])=>event.agent===office &&
              (!state.responses.has(qid) || !seen.includes(`answer:${task.id}:${qid}`)))});
          markActivity();
          for(const qid of state.responses) if(state.questions.get(qid)?.agent===office) {
            const fingerprint=`answer:${task.id}:${qid}`;
            if(seen.includes(fingerprint))continue;
            if(!ctx.isIdle())throw new Error('Oficina ocupada: respuesta queda para próximo barrido');
            const pendingCount=census?.pendingCount ?? 0;
            if(!await announce(ctx,'response',task.id,{office,id:qid,status:task.status,needsUnblock:task.status==='in_progress',
                requireBlocked:task.status==='blocked',pendingDependencies:task.status==='blocked'?pendingCount:undefined},()=>
              pi.sendUserMessage(task.status==='blocked'
                ? `🔔 respuesta disponible en ${task.id} pregunta ${qid}; sigue bloqueada por ${pendingCount} dependencias — leela en el tablero`
                : `🔔 ${teamConfig().lider} respondió ${task.id} pregunta ${qid} — leela en el tablero (estado: ${task.status})`)))continue;
            seen.push(fingerprint);
            writeFileSync(seenFile,JSON.stringify(seen)+'\n');
          }
          markActivity();
        }
      } catch(e) { logBell(bellLog, {direction:'bandeja',task_id:'',status:'fallido',error:String(e)}); }
      finally { scanning = false; }
    }, 60_000);
    timer.unref();
  });
  pi.on('session_shutdown', () => { if(timer) clearInterval(timer);timer=undefined;if(leaderTimer)clearInterval(leaderTimer);leaderTimer=undefined;if(vmTurnTimer)clearInterval(vmTurnTimer);vmTurnTimer=undefined;if(correspondenceTimer)clearInterval(correspondenceTimer);correspondenceTimer=undefined; });
  pi.on('tool_call', (event, ctx) => {
    const office = isOfficeBody(ctx.cwd) ? parseEnvFile(ctx.cwd).AGENT_NAME : undefined;
    if (office && event.toolName === 'subagent' && !practitionerAllowed(event.input.subagent_type, office)) {
      return {block:true, reason:`Esta oficina sólo permite ayudantes subagent_type: "mini-${office}"; no se lanzó ninguno.`};
    }
  });
  pi.on('tool_call', async (event,ctx) => {
    if(!['cb_task_block','cb_task_submit','cb_task_comment'].includes(event.toolName) || !isOfficeBody(ctx.cwd))return;
    const taskId=(event.input as {task_id?:unknown})?.task_id;
    if(typeof taskId!=='string' || !taskId)return;
    try {
      const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(taskId)}`);
      if(Array.isArray(activity.events))pendingEffects.set(event.toolCallId,{taskId,count:activity.events.length});
    }catch(e){logBell(bellLog,{direction:'efecto-preflight',task_id:taskId,status:'fallido',error:String(e)});}
  });
  pi.on('input', async (event, ctx) => {
    let deferInput=false;
    try {
      const office = isOfficeBody(ctx.cwd) ? parseEnvFile(ctx.cwd).AGENT_NAME : undefined;
      if(!office) {
        const id=identity(ctx);
        if(id.owner!==teamConfig().lider||id.isSubagent)return;
        if(parseContextNotice(event.text,[...offices])){
          await handleLeaderContext(ctx,event.text);
          return {action:'handled' as const};
        }
        const lines=event.text.startsWith('🔔 Oficinas: revisá el tablero\n')?event.text.split('\n').slice(1):[event.text];
        for(const line of lines){
          const received=await acceptLeaderNotice(api(ctx),line,Date.now(),task=>{
            const observation=observePaneQuiet(registry()[task.assignee]?.pane_id);
            if(observation.state==='working')logBell(bellLog,{direction:'barrido',task_id:task.id,target:task.assignee,status:'working'});
            return observation;
          });
          if(received.action!=='ignore-stale')logBell(bellLog,{direction:'vuelta',task_id:received.taskId ?? '',target:teamConfig().lider,status:'recibido'});
        }
        return;
      }
      if(!existsSync(join(ctx.cwd,'state','secretaria-gate-ok')))return;
      const parsedTask=parseOfficeNotice(event.text);
      if(parsedTask?.kind==='task-available'){
        const snapshot=contextSnapshot(ctx);
        if(shouldDeferNewTask(snapshot,'todo')){
          deferInput=true;
          const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(parsedTask.taskId)}`);
          // A reminder for a task already in progress must not interrupt its owner.
          if(task?.id===parsedTask.taskId && task.status==='in_progress' && task.assignee===office){deferInput=false;}
          else {
            if(task?.id===parsedTask.taskId && task.status==='todo' && task.assignee===office &&
               Array.isArray(task.tags) && task.tags.includes('oficina') &&
               await confirmed(ctx,'task-available',task.id,{office}) && snapshot.sessionFile && snapshot.sessionId){
              persistContextSnapshot(ctx.cwd,snapshot,snapshot.sessionFile);
              announceContextTask(ctx,office,task.id,snapshot.percent);
            }else logBell(bellLog,{direction:'contexto',task_id:parsedTask.taskId,target:office,status:'tarea nueva diferida sin atribución verificable'});
            return {action:'handled' as const};
          }
        }
      }
      const received=await acceptOfficeNotice(api(ctx),event.text,office);
      if(received.action==='read-task'){
        void probe(ctx,office);
        logBell(bellLog,{direction:'ida',task_id:received.taskId ?? '',target:office,status:'recibido'});
      }else if(received.action==='read-answer'||received.action==='stay-blocked'){
        const path=join(ctx.cwd,'state','secretaria-respuestas-seen.json');
        const seen=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
        if(!Array.isArray(seen))throw new Error('Dedupe respuestas corrupto');
        const fingerprint=`answer:${received.taskId}:${received.questionId}`;
        if(!seen.includes(fingerprint))writeFileSync(path,JSON.stringify([...seen,fingerprint])+'\n');
        logBell(bellLog,{direction:'respuesta',task_id:received.taskId ?? '',target:office,status:received.action});
      }else if(received.action==='resume'){
        logBell(bellLog,{direction:'dependencia',task_id:received.taskId ?? '',target:office,status:'recibido'});
      }
    } catch(e) { logBell(bellLog, {direction:'ida',task_id:'',status:'fallido',error:String(e)}); if(deferInput)return {action:'handled' as const}; }
  });
  pi.on('tool_result', async (event,ctx) => {
    if(event.isError || !['cb_task_claim','cb_task_submit'].includes(event.toolName) || !isOfficeBody(ctx.cwd))return;
    const supplied=(event.input as {task_id?:unknown})?.task_id;
    if(typeof supplied!=='string' || !supplied)return;
    try {
      const office=parseEnvFile(ctx.cwd).AGENT_NAME;
      if(!office || identity(ctx).owner!==office)return;
      const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(supplied)}`);
      if(task.assignee!==office || !Array.isArray(task.tags) || !task.tags.includes('oficina'))return;
      if(event.toolName==='cb_task_claim') {
        if(task.status==='in_progress' && task.claimed_by===office) recordCostClaim(ctx,ctx.cwd,task.id);
      } else if(task.status==='submitted' && task.submitted_by===office) {
        await reportTaskCost(ctx,ctx.cwd,office,task.id,api(ctx));
      }
    }catch(e){logBell(bellLog,{direction:'costo',task_id:supplied,status:'fallido',error:String(e)});}
  });
  pi.on('tool_result', async (event, ctx) => {
    const prior=pendingEffects.get(event.toolCallId);
    pendingEffects.delete(event.toolCallId);
    if (!['cb_task_submit','cb_task_comment','cb_task_block'].includes(event.toolName) || event.isError || !prior) return;
    try {
      const office = isOfficeBody(ctx.cwd) ? parseEnvFile(ctx.cwd).AGENT_NAME : undefined;
      if (!office || identity(ctx).owner !== office) return;
      const taskId = String((event.input as {task_id?: string})?.task_id || '');
      if (!taskId || prior.taskId!==taskId) return;
      const task = await get(ctx, `/task/get?task_id=${encodeURIComponent(taskId)}`);
      if (![teamConfig().lider,(process.env.PI_OFICINAS_HUMAN || 'human')].includes(task.creator)) return;
      if (event.toolName === 'cb_task_block') {
        if(task.status!=='blocked' || task.assignee!==office) return;
        const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
        const last=Array.isArray(activity.events)?[...activity.events].reverse().find((e:any)=>e.kind==='block'):undefined;
        if(!last || last.agent!==office || last.to_status!=='blocked') return;
        const type=blockType((event.input as {reason?:unknown})?.reason ?? task.blocked_reason);
        const notice=blockNotice(task,office,type);
        await announce(ctx,'block',task.id,{...notice.expected,at:last.created_at,afterCount:prior.count},()=>
          queueLeaderBell(leaderQueue,bellLog,{kind:'block',task_id:task.id,
            fingerprint:`block:${task.id}:${last.created_at ?? ''}`,
            expected:{...notice.expected,at:last.created_at,afterCount:prior.count},
            text:notice.text},lookupPane(registry(),task.creator===(process.env.PI_OFICINAS_HUMAN || 'human')?teamConfig().lider:task.creator)));
        return;
      }
      if (event.toolName === 'cb_task_submit') {
        if (task.status !== 'submitted' || task.submitted_by !== office) return;
      } else {
        if (mode !== 'read-only') return;
        const body = String((event.input as {body?:string})?.body || '');
        if (!body.startsWith(`ENTREGA·${office}\n`)) return;
        const activity = await get(ctx, `/task/activity?task_id=${encodeURIComponent(task.id)}`);
        if (!Array.isArray(activity.events) || !ownerDelivery(activity.events, office, body)) return;
      }
      const text=deliveryNotice(task,office).text;
      const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
      const last=Array.isArray(activity.events)?[...activity.events].reverse().find((e:any)=>
        e.kind==='status_change' && e.to_status==='submitted' && e.agent===office):undefined;
      const marker=event.toolName==='cb_task_comment'
        ? questionId(office,task.id,String((event.input as {body?:string}).body ?? ''))
        : (last?.created_at ?? String(task.submitted_at ?? 'submitted'));
      await announce(ctx,'delivery',task.id,{office,afterCount:prior.count,
        ...(event.toolName==='cb_task_comment'?{body:String((event.input as {body?:string}).body ?? '')}:{at:marker})},()=>
        queueLeaderBell(leaderQueue,bellLog,{kind:'delivery',task_id:task.id,
          fingerprint:`delivery:${task.id}:${marker}`,text,
          expected:{office,afterCount:prior.count,
            ...(event.toolName==='cb_task_comment'?{bodyHash:marker}:{at:marker})}},lookupPane(registry(),task.creator===(process.env.PI_OFICINAS_HUMAN || 'human')?teamConfig().lider:task.creator)));
    } catch(e) { logBell(bellLog, {direction:'vuelta',task_id:'',status:'fallido',error:String(e)}); }
  });
  if(registeredRole==='leader') pi.on('tool_result',async(event,ctx)=>{
    const cfg=teamConfig(),settings=secretaryConfig(cfg);
    if(!settings.correo||event.isError||isOfficeBody(ctx.cwd) ||
       !['correspondencia_publicar','cb_correspondencia_publicar','correspondencia_responder','cb_correspondencia_responder'].includes(event.toolName))return;
    try{
      const who=identity(ctx);if(who.owner!==cfg.lider||who.isSubagent)return;
      const publish=/correspondencia_publicar$/.test(event.toolName),input:any=event.input??{};
      if(typeof input.asunto==='string'&&input.asunto.startsWith('SECRETARÍA·timbre '))return;
      if(typeof input.contenido==='string'&&input.contenido.startsWith('{"v":1,"kind":"correspondencia",'))return;
      const code=extractSuccessfulCode(event.content,event.toolName);
      if(typeof code!=='string'||!/^[0-9a-f]{4,64}(?:\.[1-9][0-9]*)?$/i.test(code)){
        logBell(bellLog,{direction:'correspondencia',task_id:'',status:'tool exitoso sin código de origen verificable'});return;
      }
      if(!publish&&(typeof input.codigo!=='string'||!/^[0-9a-f]{4,64}(?:\.[1-9][0-9]*)?$/i.test(input.codigo)))return;
      if(publish&&!externalLeaderRecipients(input.destinatarios,cfg).length)return;
      if(typeof event.toolCallId!=='string'||! /^[A-Za-z0-9:_-]{1,128}$/.test(event.toolCallId))throw new Error('toolCallId inválido');
      const ledger=readPrivateJsonLines(correspondenceLedgerPath);
      if(ledger.some(row=>row.kind==='source_event'&&row.sourceId===event.toolCallId))return;
      const safePriority=['urgente','medio','bajo'].includes(input.prioridad)?input.prioridad:undefined;
      const safeInput=publish?{destinatarios:externalLeaderRecipients(input.destinatarios,cfg).map(name=>`@${name}/${name}`).join(','),
        ...(safePriority?{prioridad:safePriority}:{})}:
        {codigo:input.codigo.toLowerCase(),...(safePriority?{prioridad:safePriority}:{})};
      appendPrivateJsonLine(correspondenceLedgerPath,{kind:'source_event',sourceId:event.toolCallId,toolName:event.toolName,
        input:safeInput,output:{codigo:code},at:new Date().toISOString()});
      logBell(bellLog,{direction:'correspondencia',task_id:code,status:`origen ${publish?'publicar':'responder'} en cola local`});
    }catch(e){logBell(bellLog,{direction:'correspondencia',task_id:'',status:'captura de origen fallida',error:String(e)});}
  });
  // 2362a4e2: when the LEADER unblocks an office task (cb_task_unblock) and it is back in its owner's hands, queue
  // exactly ONE task-available bell bound to that unblock event (fingerprint unblock:<task>:<at>, deduplicated here and
  // by the dispatcher). Before this, unblock rang nobody and the office stayed silent with a ready task.
  if(registeredRole==='leader') pi.on('tool_result', async (event,ctx) => {
    if(event.isError || event.toolName!=='cb_task_unblock' || isOfficeBody(ctx.cwd))return;
    const supplied=(event.input as {task_id?:unknown})?.task_id;
    if(typeof supplied!=='string' || !supplied)return;
    try {
      const id=identity(ctx);
      if(id.owner!==teamConfig().lider || id.isSubagent)return;
      const task=await get(ctx,`/task/get?task_id=${encodeURIComponent(supplied)}`);
      if(!offices.has(task.assignee) || ![teamConfig().lider,(process.env.PI_OFICINAS_HUMAN || 'human')].includes(task.creator) || task.status!=='in_progress' ||
         !Array.isArray(task.tags) || !task.tags.includes('oficina'))return;
      const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
      const unblocked=unblockedLatest(activity.events);
      if(!unblocked)return;
      const fingerprint=`unblock:${task.id}:${unblocked.at}`;
      const already=[leaderQueue,leaderQueue+'.sent'].some(f=>existsSync(f) && readFileSync(f,'utf8').includes(fingerprint));
      if(already)return;
      const available=taskAvailableNotice(task);
      const expected={...available.expected,at:unblocked.at};
      await announce(ctx,'task-available',task.id,expected,()=>
        queueLeaderBell(leaderQueue,bellLog,{kind:'task-available',direction:'ida',task_id:task.id,fingerprint,expected,
          text:available.text},registry()[task.assignee]?.pane_id));
    } catch(e) { logBell(bellLog,{direction:'ida',task_id:String(supplied),status:'fallido',error:String(e)}); }
  });
  if(registeredRole!=='none') pi.registerTool({name:'vm_turno',label:'Coordinar turno VM SSM',
    description:'Coordina el acceso exclusivo a la VM: pedir, liberar, estado; la líder puede asignar o quitar agentes. No envía comandos SSM.',
    parameters:Type.Object({operacion:Type.Union([Type.Literal('pedir'),Type.Literal('liberar'),Type.Literal('estado'),Type.Literal('asignar'),Type.Literal('quitar')]),
      task_id:Type.Optional(Type.String()),minutos_max:Type.Optional(Type.Number()),agente:Type.Optional(Type.String()),motivo:Type.Optional(Type.String())}),
    async execute(_id,{operacion,task_id,minutos_max,agente,motivo},_signal,_update,ctx) {
      const taskId=typeof task_id==='string'?task_id:'';
      try {
        const cfg=teamConfig(), role=teamRole(cfg,ctx.cwd,isOfficeBody(ctx.cwd),parseEnvFile(ctx.cwd).AGENT_NAME), who=identity(ctx);
        if(role==='none' || (role==='office' && (!who.isSubagent || isPractitionerSession(ctx) ||
            !existsSync(join(ctx.cwd,'state','secretaria-gate-ok')))))throw new Error('Cuerpo/identidad/gate de oficina no verificado');
        const roster=[...cfg.oficinas,cfg.lider];
        if(['asignar','quitar'].includes(operacion) && (role!=='leader' || who.owner!==cfg.lider || who.isSubagent))
          throw new Error('Sólo la líder verificada puede asignar o quitar agentes');
        if(operacion!=='liberar')await checkVmTurnExpiry(ctx);
        if(operacion==='pedir') {
          if(!taskId || typeof minutos_max!=='number')throw new Error('pedir requiere task_id y minutos_max');
          const outcome=await pedirVmTurno(cfg.base,roster,who.owner,taskId,minutos_max);
          const label=outcome.estado.titular?`${outcome.estado.titular.agente}/${outcome.estado.titular.task_id}`:'libre';
          return {content:[{type:'text' as const,text:`${outcome.resultado}; titular=${label}; cola=${outcome.estado.cola.map(row=>`${row.agente}/${row.task_id}`).join(',')||'vacía'}`}],details:outcome.estado};
        }
        if(operacion==='liberar') {
          if(!taskId)throw new Error('liberar requiere task_id');
          const outcome=await liberarVmTurno(cfg.base,roster,who.owner,taskId);
          if(outcome.notificar)notifyVmTurn(outcome.notificar.agente,outcome.notificar.task_id,
            `🔔 Turno VM disponible: te corresponde ahora por FIFO para ${outcome.notificar.task_id}; vence como máximo ${outcome.estado.titular?.hasta}. Confirmá que no haya un CID anterior en vuelo antes de enviar uno.`, 'ida');
          return {content:[{type:'text' as const,text:outcome.resultado}],details:outcome.estado};
        }
        if(operacion==='estado') {
          const state=await estadoVmTurno(cfg.base,roster);
          return {content:[{type:'text' as const,text:JSON.stringify(state)}],details:state};
        }
        if(operacion==='asignar') {
          if(typeof agente!=='string' || !taskId || typeof minutos_max!=='number')throw new Error('asignar requiere agente, task_id y minutos_max');
          const outcome=await asignarVmTurno(cfg.base,roster,who.owner,agente,taskId,minutos_max,motivo);
          if(outcome.desalojado)notifyVmTurn(outcome.desalojado.agente,outcome.desalojado.task_id,
            `🔔 Te sacaron el turno VM: ${outcome.notificar?.agente ?? 'otro agente'} tiene ahora el turno para ${outcome.desalojado.nuevo_task_id}; tu tarea ${outcome.desalojado.task_id} queda al frente de la cola. La reasignación no cancela un CID en vuelo: informá su estado a la líder.`, 'ida');
          if(outcome.notificar)notifyVmTurn(outcome.notificar.agente,outcome.notificar.task_id,
            `🔔 La líder te asignó el turno VM para ${outcome.notificar.task_id}; vence como máximo ${outcome.estado.titular?.hasta}. Confirmá que no haya un CID previo en vuelo antes de enviar uno; ninguna asignación cancela CIDs.`, 'ida');
          return {content:[{type:'text' as const,text:outcome.resultado}],details:outcome.estado};
        }
        if(operacion==='quitar') {
          if(typeof agente!=='string')throw new Error('quitar requiere agente');
          const outcome=await quitarVmTurno(cfg.base,roster,who.owner,agente,motivo);
          if(outcome.removido)notifyVmTurn(outcome.removido.agente,outcome.removido.task_id,
            `🔔 La líder te quitó del turno/cola VM para ${outcome.removido.task_id}. No se cancela un CID en vuelo; comunicá su estado.`, 'ida');
          if(outcome.notificar)notifyVmTurn(outcome.notificar.agente,outcome.notificar.task_id,
            `🔔 Turno VM disponible: te corresponde ahora por FIFO para ${outcome.notificar.task_id}; vence como máximo ${outcome.estado.titular?.hasta}. Confirmá que no haya un CID anterior en vuelo antes de enviar uno.`, 'ida');
          return {content:[{type:'text' as const,text:outcome.resultado}],details:outcome.estado};
        }
        throw new Error('Operación vm_turno desconocida');
      } catch(e) {logBell(bellLog,{direction:'vm-turno',task_id:taskId,status:'fallido',error:String(e)});
        return {content:[{type:'text' as const,text:`vm_turno no cambió el registro: ${e}`}],details:undefined};}
    }});
  if(registeredRole==='leader') pi.registerTool({name:'oficina_asignar',label:'Tocar timbre oficina',description:'Verifica tarea asignada y avisa a la oficina sin enviar orden.',
    parameters:Type.Object({agente:Type.String(),task_id:Type.String()}),
    async execute(_id, {agente,task_id}, _signal, _update, ctx) {
      try {
        const task = await get(ctx, `/task/get?task_id=${encodeURIComponent(task_id)}`);
        if (!offices.has(agente) || task.creator!==teamConfig().lider || task.assignee !== agente)
          throw new Error('Tarea no existe, no corresponde a ese agente o no fue verificada');
        const activity=await get(ctx,`/task/activity?task_id=${encodeURIComponent(task.id)}`);
        const transition=taskAvailabilityTransition(activity.events);
        const latestState=Array.isArray(activity.events)?activity.events.filter((e:any)=>e && (e.to_status!=null || e.kind==='handoff')).at(-1):undefined;
        const ready=task.status==='todo'
          ? (!latestState || transition?.kind==='todo' || transition?.kind==='handoff')
          : task.status==='in_progress' ? !!transition
          : task.status==='submitted' ? !!transition && (transition.kind==='review' || transition.kind==='todo' ||
              (transition.kind==='handoff' && returnedForChanges(activity.events)))
          : false;
        if(!ready) throw new Error('Tarea no existe, no está disponible tras needs_changes/handoff/todo, o no corresponde a ese agente');
        const pane = registry()[agente]?.pane_id;
        if (!pane) throw new Error('Oficina sin pane');
        const marker=transition?.at ?? (Array.isArray(activity.events)?activity.events.at(-1)?.created_at ?? task.status:task.status);
        const available=taskAvailableNotice(task);
        const expected={office:agente,...(transition?{transition:transition.kind,...(transition.at?{at:transition.at}:{})}:{})};
        if(!await announce(ctx,'task-available',task.id,expected,()=>
          queueLeaderBell(leaderQueue,bellLog,{kind:'task-available',direction:'ida',task_id:task.id,
            fingerprint:`available:${task.id}:${transition?.kind ?? task.status}:${marker}`,expected,
            text:available.text},pane)))
          throw new Error('Tarea no confirmada por actividad/status');
        return {content:[{type:'text' as const,text:`Timbre encolado ${agente} ${task.id}`}],details:undefined};
      } catch(e) { logBell(bellLog,{direction:'ida',task_id,status:'fallido',error:String(e)}); return {content:[{type:'text' as const,text:`No se tocó timbre: ${e}`}],details:undefined}; }
    }});
  if(isOfficeBody(process.cwd()) && registeredRole==='office') pi.registerTool({name:'oficina_preguntar',label:'Preguntar al líder por tablero',
    description:'Registra PREGUNTA en la tarea propia, puede bloquearla y avisa al líder sólo con ID.',
    parameters:Type.Object({task_id:Type.String(),pregunta:Type.String(),bloquea:Type.Boolean(),
      depends_on_id:Type.Optional(Type.String())}),
    async execute(_id,{task_id,pregunta,bloquea,depends_on_id},_signal,_update,ctx) {
      try {
        const office=parseEnvFile(ctx.cwd).AGENT_NAME;
        if(!isOfficeBody(ctx.cwd) || isPractitionerSession(ctx) || !existsSync(join(ctx.cwd,'state','secretaria-gate-ok')) || !office ||
           identity(ctx).owner!==office || !identity(ctx).isSubagent) throw new Error('Oficina no verificada');
        const api={get:(path:string)=>get(ctx,path),post:(path:string,body:Record<string,unknown>)=>post(ctx,path,body)};
        const {id,task,newQuestion,dependencyWarning}=await askOffice(api,office,task_id,pregunta,bloquea,depends_on_id);
        officeActivityState.delete(task.id); // 98bf4465: la pregunta nueva reabre el seguimiento de respuestas
        if(newQuestion) {
          const notice=questionNotice(task,office,id);
          if(!await announce(ctx,'question',task.id,{...notice.expected,needsUnblock:bloquea},()=>
            queueLeaderBell(leaderQueue,bellLog,{kind:'question',task_id:task.id,
              fingerprint:`question:${task.id}:${id}`,expected:notice.expected,text:notice.text},
              lookupPane(registry(),teamConfig().lider))))throw new Error('Pregunta sin efecto confirmado; NO timbrar');
        }
        return {content:[{type:'text' as const,text:`PREGUNTA·${office}·${id} ${newQuestion?'registrada':'ya registrada'} estado=${task.status}${dependencyWarning?` — ${dependencyWarning}`:''}`}],details:undefined};
      }catch(e){logBell(bellLog,{direction:'pregunta',task_id,status:'fallido',error:String(e)});
        return {content:[{type:'text' as const,text:`Pregunta no registrada: ${e}`}],details:undefined};}
    }});
  else if(registeredRole==='leader') pi.registerTool({name:'oficina_responder',label:'Responder pregunta de oficina',
    description:'Publica RESPUESTA en el tablero, desbloquea si corresponde y avisa a oficina sin contenido.',
    parameters:Type.Object({task_id:Type.String(),id_pregunta:Type.String(),respuesta:Type.String()}),
    async execute(_id,{task_id,id_pregunta,respuesta},_signal,_update,ctx) {
      let responsePostAccepted:{task_id:string;question_id:string}|undefined;
      let responseOffice:string|undefined;
      try {
        const id=identity(ctx);
        if(isOfficeBody(ctx.cwd) || id.owner!==teamConfig().lider || id.isSubagent) throw new Error('Sólo líder verificada');
        const api={get:async(path:string)=>{
          const data=await get(ctx,path);
          if(path.startsWith('/task/get?') && typeof data?.assignee==='string')responseOffice=data.assignee;
          return data;
        },post:(path:string,body:Record<string,unknown>)=>{
          let responseQuestionId:string|undefined;
          if(path==='/task/comment' && typeof body.task_id==='string' && typeof body.body==='string'){
            const prefix=`RESPUESTA·${teamConfig().lider}·`;
            if(body.body.startsWith(prefix))responseQuestionId=/^([a-f0-9]{16})\n/.exec(body.body.slice(prefix.length))?.[1];
          }
          return post(ctx,path,body,()=>{
            if(responseQuestionId && typeof body.task_id==='string')responsePostAccepted={task_id:body.task_id,question_id:responseQuestionId};
          });
        }};
        const {task,answeredNow,unblockedNow,pendingDependencies,pendingDependencyIds,pendingQuestionIds}=await answerOffice(api,task_id,id_pregunta,respuesta);
        if(answeredNow || unblockedNow) {
          const notice=responseNotice(task,id_pregunta,pendingDependencies,unblockedNow,pendingDependencyIds,pendingQuestionIds);
          if(!await announce(ctx,'response',task.id,notice.expected,()=>
            queueLeaderBell(leaderQueue,bellLog,{kind:'response',direction:'ida',task_id:task.id,
              fingerprint:`response-ida:${task.id}:${id_pregunta}:${unblockedNow?'unblock':'comment'}`,
              expected:notice.expected,text:notice.text},registry()[task.assignee]?.pane_id)))
            throw new Error('Respuesta sin efecto confirmado; NO timbrar');
        }
        return {content:[{type:'text' as const,text:`RESPUESTA·${teamConfig().lider}·${id_pregunta} ${answeredNow?'registrada':'ya registrada'} estado=${task.status} pendientes=${pendingDependencies}`}],details:undefined};
      }catch(e){
        if(responsePostAccepted){
          const accepted=responsePostAccepted;
          let retryTarget:string|undefined;
          try {const candidate=responseOffice?registry()[responseOffice]?.pane_id:undefined;if(validPaneId(candidate))retryTarget=candidate;}catch{}
          const retryNotice:LeaderNotice={kind:'response',direction:'ida',task_id:accepted.task_id,
            fingerprint:`response-ida:${accepted.task_id}:${accepted.question_id}:comment`,
            ...(retryTarget?{target:retryTarget}:{}),
            expected:{...(responseOffice?{office:responseOffice}:{}),id:accepted.question_id},
            text:`🔔 RESPUESTA·${teamConfig().lider}·${accepted.question_id} en ${accepted.task_id}: verificar/reintentar timbre`};
          try {
            const attempt=persistBellRetry(leaderQueue,retryNotice,'post_accepted_confirmation_failed');
            logBell(bellLog,{direction:'ida',task_id:accepted.task_id,status:`retry post_accepted_confirmation_failed attempt=${attempt}`,error:String(e)});
            return {content:[{type:'text' as const,text:`RESPUESTA·${teamConfig().lider}·${accepted.question_id} POST aceptado; confirmación posterior falló. Timbre de recuperación visible en ${leaderQueue}.retry (intento ${attempt}); revisa el tablero antes de repetir.`}],details:undefined};
          }catch(retryError){
            logBell(bellLog,{direction:'ida',task_id:accepted.task_id,status:'CRITICO retry de respuesta no persistido',error:`${String(e)}; ${String(retryError)}`});
            return {content:[{type:'text' as const,text:`CRÍTICO: el POST RESPUESTA para ${accepted.task_id} fue aceptado pero falló la confirmación y no se pudo persistir el timbre .retry; no repitas a ciegas, revisa el tablero/registro local.`}],details:undefined};
          }
        }
        logBell(bellLog,{direction:'respuesta',task_id,status:'fallido',error:String(e)});
        return {content:[{type:'text' as const,text:`Respuesta no registrada: ${e}`}],details:undefined};
      }
    }});
  if(registeredRole==='leader') pi.registerTool({name:'oficina_estado',label:'Estado oficinas',description:'Lee registro de panes; vista monitor agrega actividad/contexto de sólo lectura.',parameters:Type.Object({vista:Type.Optional(Type.Literal('monitor'))}),
    async execute(_id,{vista},_signal,_update,ctx) {
      if(!vista)return {content:[{type:'text' as const,text:JSON.stringify(registry())}],details:undefined};
      try{
        const cfg=teamConfig(),who=identity(ctx);
        if(who.owner!==cfg.lider||who.isSubagent||teamRole(cfg,ctx.cwd,false)!=='leader')throw new Error('Sólo la líder verificada puede consultar el monitor');
        if(!secretaryConfig(cfg).monitor)throw new Error('Monitor deshabilitado por configuración del equipo');
        const data=await collectMonitorData(ctx,Date.now());
        return {content:[{type:'text' as const,text:JSON.stringify(data.report,null,2)}],details:data.report};
      }catch(e){return {content:[{type:'text' as const,text:`Monitor desconocido: ${String(e)}`}],details:undefined};}
    }});
}
