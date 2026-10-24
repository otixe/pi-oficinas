import { correspondenceItems, formatIncomingBell, isOwnLeaderMailbox, isLeaderMailbox, sameCorrespondenceSender, leaderRegistryCandidate,
  secretarialNoticeSubject, parseSecretarialNoticeSubject,
  planIncoming, resolveOutgoingContext, validNoticeStillOpen, originalStillUnread,
  destinationHasAcknowledged, type CorrespondenceRow, type IncomingOriginal, type MailPriority } from './secretaria-correspondence.ts';
import { acquireNoticeReservation, archiveNoticeReservation, reservationAgeMs, reservationOwnerInfo,
  reservationRecordDate, RESERVATION_IDENTITY_TIMEOUT_REASON, RESERVATION_RECOVERY_IDENTITY_TIMEOUT_REASON,
  type NoticeReservationLease, type NoticeReservationRecord, type ProcessIdentityProbe } from './secretaria-correspondence-reservation.ts';

export interface CorrespondenceApi {get(path:string):Promise<any>;post(path:string,body:Record<string,unknown>):Promise<any>}
export interface CorrespondenceLedgerRow {kind:string;at?:string;day?:string;hour?:string;codigo?:string;original?:string;noticeCode?:string;destination?:string;remitente?:string;prioridad?:string;asunto?:string;latencyMinutes?:number;sourceId?:string;toolName?:string;input?:any;output?:any;status?:string;reason?:string;minutes?:number;activatedAt?:string;codes?:string[];lowCodes?:string[];reservationToken?:string;ownerPid?:number;ownerHostname?:string;ownerBootId?:string|null;ownerProcessStarttime?:string|null;ownerInstanceToken?:string}
export interface ReservationIdentityAlert {original:string;destination:string;reason:string;createdAt:string;confirmMin:number}
export interface NoticeReservationRuntime {stateDirectory:string;confirmMin:number;reloadLedger:()=>CorrespondenceLedgerRow[];identityProbe?:ProcessIdentityProbe;onIdentityUncertain?:(alert:ReservationIdentityAlert)=>void}
const INBOX='/correspondencia/bandeja?archivo=false&incluir_contenido=false';
const exactCode=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{16}$/.test(x);
const dateKey=(now:number)=>new Date(now).toISOString().slice(0,10);
const hourKey=(now:number)=>new Date(now).toISOString().slice(0,13);
function codeFromPostResult(raw:any):string|null {
  const rows=[raw?.codigo,raw?.code,raw?.result?.codigo,raw?.result?.code];
  for(const row of rows)if(exactCode(row))return row;
  if(typeof raw?.result==='string'){
    const match=/(?:c[oó]digo|code)\s*[:=#]\s*([0-9a-f]{16})/i.exec(raw.result);
    if(match)return match[1];
  }
  return null;
}
function rateWindowKey(row:CorrespondenceLedgerRow,window:'day'|'hour'):string|undefined {
  const saved=window==='day'?row.day:row.hour;if(typeof saved==='string')return saved;
  const at=typeof row.at==='string'?Date.parse(row.at):NaN;if(!Number.isFinite(at))return undefined;
  return window==='day'?new Date(at).toISOString().slice(0,10):new Date(at).toISOString().slice(0,13);
}
export function f4WindowCount(ledger:CorrespondenceLedgerRow[],window:'day'|'hour',now:number):number {
  const key=window==='day'?dateKey(now):hourKey(now),unique=new Set<string>();
  for(const row of ledger){if(rateWindowKey(row,window)!==key)continue;
    if(['notice_pending','notice_sent','notice_capped','notice_uncertain'].includes(row.kind)&&typeof row.original==='string'&&typeof row.destination==='string')
      unique.add(`out:${row.original}:${row.destination}`);
    else if(['incoming_queued','incoming_capped'].includes(row.kind)&&typeof row.codigo==='string')unique.add(`in:${row.codigo}`);
    else if(['notice_timeout','notice_timeout_capped'].includes(row.kind)&&typeof row.noticeCode==='string')unique.add(`timeout:${row.noticeCode}`);
  }
  return unique.size;
}
function terminalNotice(ledger:CorrespondenceLedgerRow[],code:string,destination:string):CorrespondenceLedgerRow|undefined {
  return ledger.find(row=>['notice_sent','notice_capped','notice_uncertain'].includes(row.kind)&&
    row.original===code&&row.destination===destination);
}
function replaceLedger(target:CorrespondenceLedgerRow[],fresh:CorrespondenceLedgerRow[]):void {
  if(!Array.isArray(fresh)||fresh.some(row=>!row||typeof row.kind!=='string'))throw new Error('Ledger local F4 inválido al revalidar reserva');
  target.splice(0,target.length,...fresh);
}
export async function emitSecretarialNotices(api:CorrespondenceApi,leader:string,intent:{toolName:string;input:any;output:unknown},
  ledger:CorrespondenceLedgerRow[],limits:{daily:number;hourly:number},now:number,canSend:()=>boolean,
  record:(entry:Record<string,unknown>)=>void,ownOffices:readonly string[]=[],isExternalLeader?:(name:string)=>Promise<boolean>,
  reservation?:NoticeReservationRuntime):Promise<{status:'sent'|'capped'|'pending-pane'|'unverified'|'ignored'|'none'|'reserved';sent:number;reserved?:boolean}> {
  if(!canSend())return {status:'pending-pane',sent:0};
  const raw=await api.get(INBOX),mailbox=correspondenceItems(raw);if(!mailbox)return {status:'unverified',sent:0};
  if(/(?:cb_)?correspondencia_responder$/.test(intent.toolName)&&typeof intent.input?.codigo==='string'){
    const parent=mailbox.find(row=>row.codigo===intent.input.codigo&&isOwnLeaderMailbox(row.buzon,leader));
    // A reply to a fixed secretarial notice must never create a notice about the notice.
    if(parent&&parseSecretarialNoticeSubject(parent.asunto))return {status:'ignored',sent:0};
  }
  const context=resolveOutgoingContext(raw,intent.toolName,intent.input,intent.output,leader,ownOffices);
  if(!context)return {status:'unverified',sent:0};
  if(context.prioridad==='bajo')return {status:'ignored',sent:0}; // 277eb7cf: bajo nunca manda SECRETARÍA·timbre; el receptor nunca se enteraría sin leer su propia bandeja
  if(!reservation?.stateDirectory||!reservation.reloadLedger)return {status:'unverified',sent:0};
  const destinations=isExternalLeader? (await Promise.all(context.destinos.map(async name=>await isExternalLeader(name)?name:null))).filter((name):name is string=>!!name):context.destinos;
  let sent=0,capped=false,waiting=false,paneWaiting=false;
  const save=(entry:Record<string,unknown>)=>{record(entry);ledger.push(entry as CorrespondenceLedgerRow);};
  const refresh=()=>replaceLedger(ledger,reservation.reloadLedger());
  const saveWait=(code:string,destination:string,token:string|undefined,owner?:ReturnType<typeof reservationOwnerInfo>,reason='reserved-by-other-process')=>{
    const reservationToken=token??'unknown';
    if(ledger.some(row=>row.kind==='notice_reserved_elsewhere'&&row.original===code&&row.destination===destination&&
      row.reservationToken===reservationToken&&row.reason===reason))return;
    const info=owner??{};
    save({kind:'notice_reserved_elsewhere',original:code,destination,reservationToken,...(owner?.pid?{ownerPid:owner.pid}:{}),
      ...(owner?.hostname?{ownerHostname:owner.hostname}:{}),...(info.bootId!==undefined?{ownerBootId:info.bootId}:{}),
      ...(info.processStarttime!==undefined?{ownerProcessStarttime:info.processStarttime}:{}),
      ...(info.instanceToken?{ownerInstanceToken:info.instanceToken}:{}),reason,at:new Date(now).toISOString()});
  };
  const uncertainReason=(reason:string)=>reason===RESERVATION_IDENTITY_TIMEOUT_REASON||reason===RESERVATION_RECOVERY_IDENTITY_TIMEOUT_REASON;
  const emitIdentityUncertainty=(code:string,destination:string,reason:string,createdAt:string,owner?:NoticeReservationRecord)=>{
    let row=ledger.find(item=>item.kind==='notice_uncertain'&&item.original===code&&item.destination===destination&&item.reason===reason);
    if(!row){const info=reservationOwnerInfo(owner);save({kind:'notice_uncertain',original:code,destination,reason,at:new Date(now).toISOString(),createdAt,
      ...(info.pid?{ownerPid:info.pid}:{}),...(info.hostname?{ownerHostname:info.hostname}:{}),
      ...(info.bootId!==undefined?{ownerBootId:info.bootId}:{}),...(info.processStarttime!==undefined?{ownerProcessStarttime:info.processStarttime}:{}),
      ...(info.instanceToken?{ownerInstanceToken:info.instanceToken}:{})});row=ledger.at(-1);}
    if(!ledger.some(item=>item.kind==='notice_reservation_alerted'&&item.original===code&&item.destination===destination&&item.reason===reason)&&
       reservation.onIdentityUncertain){
      reservation.onIdentityUncertain({original:code,destination,reason,createdAt:String(row?.createdAt??createdAt),confirmMin:reservation.confirmMin});
      save({kind:'notice_reservation_alerted',original:code,destination,reason,at:new Date(now).toISOString()});
    }
    waiting=true;
  };
  const saveAdopted=(code:string,destination:string,notice:CorrespondenceRow,pending:CorrespondenceLedgerRow|undefined,lease:NoticeReservationLease)=>{
    if(ledger.some(row=>row.kind==='notice_sent'&&row.original===code&&row.destination===destination))return;
    const at=notice.creado_en??pending?.at??reservationRecordDate(lease.previous??lease.record,lease.previousMtimeMs);
    const stamp=Date.parse(at);const when=Number.isFinite(stamp)?stamp:now;
    save({kind:'notice_sent',original:code,noticeCode:notice.codigo,destination,prioridad:notice.prioridad,
      day:pending?.day??dateKey(when),hour:pending?.hour??hourKey(when),at});sent++;
  };
  const findExactNotice=(rawInbox:unknown,code:string,destination:string)=>{
    const rows=correspondenceItems(rawInbox);if(!rows)throw new Error('Bandeja Correspondencia metadata inválida durante recuperación');
    return rows.find(row=>row.asunto===secretarialNoticeSubject(code)&&isLeaderMailbox(row.buzon,destination)&&
      sameCorrespondenceSender(row.remitente,leader));
  };
  const cleanupTerminalReservation=(code:string)=>{
    const claim=acquireNoticeReservation(reservation.stateDirectory,code,now,reservation.confirmMin,reservation.identityProbe);
    if(claim.status==='acquired')archiveNoticeReservation(reservation.stateDirectory,claim.lease.file,code,'terminal-ledger');
    else if(claim.status==='stale'){
      archiveNoticeReservation(reservation.stateDirectory,claim.lease.mainFile,code,'terminal-ledger');
      archiveNoticeReservation(reservation.stateDirectory,claim.lease.file,code,'terminal-recovery');
    }
  };
  const handleStaleReservation=async(lease:NoticeReservationLease,destination:string,pending:CorrespondenceLedgerRow|undefined):Promise<void>=>{
    try{
      refresh();
      if(terminalNotice(ledger,context.codigo,destination)){
        archiveNoticeReservation(reservation.stateDirectory,lease.mainFile,context.codigo,'terminal-ledger');return;
      }
      const fresh=await api.get(INBOX),notice=findExactNotice(fresh,context.codigo,destination);
      if(notice){saveAdopted(context.codigo,destination,notice,ledger.find(row=>row.kind==='notice_pending'&&
        row.original===context.codigo&&row.destination===destination),lease);
        archiveNoticeReservation(reservation.stateDirectory,lease.mainFile,context.codigo,'adopted-sent');return;}
      const pendingFresh=ledger.find(row=>row.kind==='notice_pending'&&row.original===context.codigo&&row.destination===destination)||pending;
      const ageMs=pendingFresh?.at?reservationAgeMs(undefined,Date.parse(pendingFresh.at),now):
        reservationAgeMs(lease.previous,lease.previousMtimeMs,now);
      if(ageMs<reservation.confirmMin*60_000){
        const owner=reservationOwnerInfo(lease.previous);saveWait(context.codigo,destination,lease.previous?.token,owner,'dead-reservation-within-confirmation-grace');
        waiting=true;return;
      }
      save({kind:'notice_uncertain',original:context.codigo,destination,day:pendingFresh?.day??dateKey(now),
        hour:pendingFresh?.hour??hourKey(now),at:new Date(now).toISOString(),reason:'dead reservation expired without a verifiable sent notice; fail closed'});
      archiveNoticeReservation(reservation.stateDirectory,lease.mainFile,context.codigo,'expired-uncertain');
    }finally{
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'recovery-claim-finished');
    }
  };
  for(const destination of destinations){
    refresh();
    const terminal=terminalNotice(ledger,context.codigo,destination);
    if(terminal?.kind==='notice_uncertain'&&uncertainReason(String(terminal.reason??'')))
      emitIdentityUncertainty(context.codigo,destination,String(terminal.reason),String(terminal.createdAt??terminal.at??reservationRecordDate(undefined,Date.now())));
    if(terminal){
      cleanupTerminalReservation(context.codigo);continue;
    }
    if(!canSend()){paneWaiting=true;continue;}
    const claim=acquireNoticeReservation(reservation.stateDirectory,context.codigo,now,reservation.confirmMin,reservation.identityProbe);
    if(claim.status==='busy'){
      refresh();if(terminalNotice(ledger,context.codigo,destination))continue;
      saveWait(context.codigo,destination,claim.token??claim.owner?.token,claim.owner,claim.reason);waiting=true;continue;
    }
    if(claim.status==='uncertain'){
      refresh();emitIdentityUncertainty(context.codigo,destination,claim.reason,claim.createdAt??new Date(now).toISOString(),claim.owner);
      continue;
    }
    if(claim.status==='stale'){
      await handleStaleReservation(claim.lease,destination,ledger.find(row=>row.kind==='notice_pending'&&
        row.original===context.codigo&&row.destination===destination));continue;
    }
    const lease=claim.lease;
    refresh();
    if(terminalNotice(ledger,context.codigo,destination)){
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'terminal-ledger');continue;
    }
    const pending=ledger.find(row=>row.kind==='notice_pending'&&row.original===context.codigo&&row.destination===destination);
    if(pending){
      const notice=findExactNotice(await api.get(INBOX),context.codigo,destination);
      if(notice){saveAdopted(context.codigo,destination,notice,pending,lease);
        archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'pending-adopted');continue;}
      const ageMs=pending.at?reservationAgeMs(undefined,Date.parse(pending.at),now):
        reservationAgeMs(lease.record,undefined,now);
      if(ageMs<reservation.confirmMin*60_000){saveWait(context.codigo,destination,lease.record.token,
        reservationOwnerInfo(lease.record),'pending-within-confirmation-grace');waiting=true;continue;}
      save({kind:'notice_uncertain',original:context.codigo,destination,day:pending.day??dateKey(now),hour:pending.hour??hourKey(now),
        at:new Date(now).toISOString(),reason:'pending reservation expired without a verifiable sent notice; fail closed'});
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'pending-expired');continue;
    }
    const usedDay=f4WindowCount(ledger,'day',now),usedHour=f4WindowCount(ledger,'hour',now);
    if(usedDay>=limits.daily||usedHour>=limits.hourly){
      save({kind:'notice_capped',original:context.codigo,destination,day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});
      capped=true;archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'capped');continue;
    }
    const confirmedRaw=await api.get(INBOX),confirmed=resolveOutgoingContext(confirmedRaw,intent.toolName,intent.input,intent.output,leader,ownOffices);
    if(!confirmed||confirmed.codigo!==context.codigo||!confirmed.destinos.includes(destination)||
       (isExternalLeader&&!await isExternalLeader(destination))){
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'revalidation-failed');continue;
    }
    if(!canSend()){
      paneWaiting=true;archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'leader-not-idle');continue;
    }
    save({kind:'notice_pending',original:context.codigo,destination,day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});
    const content=`${JSON.stringify({v:1,kind:'correspondencia',codigo:context.codigo,remitente:leader,prioridad:context.prioridad})}\n`+
      `Aviso automático de la secretaría de @${leader}: tenés la Correspondencia ${context.codigo} — leela con cb_correspondencia_leer`;
    try{
      const result=await api.post('/correspondencia/publicar',{destinatarios:[`@${destination}/${destination}`],
        asunto:`SECRETARÍA·timbre ${context.codigo}`,prioridad:context.prioridad,tipo:'inform',contenido:content});
      const noticeCode=codeFromPostResult(result);
      if(!noticeCode){save({kind:'notice_uncertain',original:context.codigo,destination,day:dateKey(now),hour:hourKey(now),
        at:new Date(now).toISOString(),reason:'POST sin código verificable; no reintentar a ciegas'});
        archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'post-uncertain');continue;}
      save({kind:'notice_sent',original:context.codigo,noticeCode,destination,prioridad:context.prioridad,
        day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});sent++;
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'sent');
    }catch(error){
      save({kind:'notice_uncertain',original:context.codigo,destination,day:dateKey(now),hour:hourKey(now),
        at:new Date(now).toISOString(),reason:`POST ambiguo (${String(error)})`});
      archiveNoticeReservation(reservation.stateDirectory,lease.file,context.codigo,'post-uncertain');
    }
  }
  return {status:sent?'sent':capped?'capped':waiting?'reserved':paneWaiting?'pending-pane':'none',sent,...(waiting?{reserved:true}:{})};
}

/** Medios que ya quedaron en el ledger como 'incoming_batched' pero todavía NO salieron en un
 * lote ('incoming_batch_sent'). El orden es por 'at' ascendente, para que el lote liste primero
 * lo más viejo. Nada se pierde: cada medio permanece acá hasta que un lote lo incluya. */
export function pendingBatchedMedium(ledger:CorrespondenceLedgerRow[]):IncomingOriginal[] {
  const sent=new Set(ledger.filter(row=>row.kind==='incoming_batch_sent')
    .flatMap(row=>Array.isArray(row.codes)?row.codes:[]));
  const byCode=new Map<string,CorrespondenceLedgerRow>();
  for(const row of ledger)if(row.kind==='incoming_batched'&&typeof row.codigo==='string')byCode.set(row.codigo,row);
  return [...byCode.values()].filter(row=>!sent.has(row.codigo!))
    .sort((a,b)=>String(a.at??'').localeCompare(String(b.at??'')))
    .map(row=>({codigo:row.codigo!,remitente:row.remitente!,prioridad:'medio' as MailPriority,asunto:row.asunto??''}));
}
/** Cuántos 'incoming_low' todavía no se mencionaron en ningún lote ('+N bajos'), para que el
 * próximo lote los cuente sin que ninguno quede invisible para siempre (277eb7cf). */
export function pendingLowCount(ledger:CorrespondenceLedgerRow[]):number {
  const mentioned=new Set(ledger.filter(row=>row.kind==='incoming_batch_sent')
    .flatMap(row=>Array.isArray(row.lowCodes)?row.lowCodes:[]));
  const low=new Set(ledger.filter(row=>row.kind==='incoming_low'&&typeof row.codigo==='string').map(row=>row.codigo!));
  let count=0;for(const code of low)if(!mentioned.has(code))count++;
  return count;
}
/** Úlltimo 'at' de un 'incoming_batch_sent' en ms epoch, o null si nunca hubo un lote (así el
 * primer lote nunca queda bloqueado esperando un lote anterior que no existe). */
export function lastBatchSentAtMs(ledger:CorrespondenceLedgerRow[]):number|null {
  const at=ledger.filter(row=>row.kind==='incoming_batch_sent').map(row=>Date.parse(String(row.at??''))).filter(Number.isFinite);
  return at.length?Math.max(...at):null;
}
/** Decisión PURA de si corresponde mandar el lote de medios AHORA (277eb7cf, regla de entrada):
 * hay al menos un medio pendiente, pasaron >= batchEveryMin desde el último lote (o nunca hubo
 * uno), y the human no habló (mensaje de usuario real) en los últimos silenceMin minutos. Un urgente
 * JAMáS espera a esto: sale solo, por su propio camino en processIncomingCorrespondence. */
export function shouldSendBatch(ledger:CorrespondenceLedgerRow[],now:number,batchEveryMin:number,humanActive:boolean):boolean {
  const pending=pendingBatchedMedium(ledger);
  if(!pending.length)return false;
  if(humanActive)return false;
  const lastBatchAt=lastBatchSentAtMs(ledger);
  if(lastBatchAt===null)return true;
  return now-lastBatchAt>=batchEveryMin*60_000;
}

export interface IncomingProcessResult {queued:IncomingOriginal[];acknowledgedNotices:string[];rejectedNotices:string[];capped:string[];batched:IncomingOriginal[];low:string[]}
export async function processIncomingCorrespondence(api:CorrespondenceApi,leader:string,ledger:CorrespondenceLedgerRow[],
  limits:{daily:number;hourly:number;fallback:boolean},now:number,queue:(row:IncomingOriginal)=>boolean,
  record:(entry:Record<string,unknown>)=>void,knownLeaders?:ReadonlySet<string>):Promise<IncomingProcessResult> {
  const raw=await api.get(INBOX),seen=new Set(ledger.filter(row=>row.kind==='incoming_queued'||row.kind==='incoming_capped'||row.kind==='incoming_baseline_seen'||row.kind==='incoming_batched'||row.kind==='incoming_low')
    .flatMap(row=>Array.isArray(row.codes)?row.codes:(typeof row.codigo==='string'?[row.codigo]:[]))
    .filter((code):code is string=>typeof code==='string'));
  const baselineSeen=new Set(ledger.filter(row=>row.kind==='incoming_baseline_seen')
    .flatMap(row=>Array.isArray(row.codes)?row.codes:(typeof row.codigo==='string'?[row.codigo]:[]))
    .filter((code):code is string=>typeof code==='string'));
  const plan=planIncoming(raw,leader,limits.fallback,seen,knownLeaders);if(!plan)throw new Error('Bandeja Correspondencia metadata inválida');
  const rows=correspondenceItems(raw);if(!rows)throw new Error('Bandeja Correspondencia metadata inválida');
  const save=(entry:Record<string,unknown>)=>{record(entry);ledger.push(entry as CorrespondenceLedgerRow);};
  const queued:IncomingOriginal[]=[],capped:string[]=[],acknowledgedNotices:string[]=[],batched:IncomingOriginal[]=[],low:string[]=[];
  for(const candidate of plan.notify){
    if(seen.has(candidate.codigo))continue;
    const countDay=f4WindowCount(ledger,'day',now);
    const countHour=f4WindowCount(ledger,'hour',now);
    if(countDay>=limits.daily||countHour>=limits.hourly){capped.push(candidate.codigo);continue;}
    const latest=await api.get(INBOX);
    if(!originalStillUnread(latest,leader,candidate.codigo,candidate.remitente))continue;
    if(candidate.prioridad==='bajo'){
      // Nunca se timbra ni se marca leído: queda en la bandeja real del Cerebro, visible
      // para ops_brief. Sólo marcamos 'seen' en NUESTRO ledger para no reprocesarlo cada
      // barrido; el próximo lote de medios lo menciona como '+N bajos' (277eb7cf).
      save({kind:'incoming_low',codigo:candidate.codigo,remitente:candidate.remitente,prioridad:candidate.prioridad,
        asunto:candidate.asunto,day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});
      seen.add(candidate.codigo);low.push(candidate.codigo);continue;
    }
    if(candidate.prioridad==='medio'){
      // Se agrupa: NO se llama queue() (eso sería un timbre inmediato). Queda registrado como
      // 'incoming_batched' y lo levanta el próximo lote (ver pendingBatchedMedium() + secretaria.ts).
      save({kind:'incoming_batched',codigo:candidate.codigo,remitente:candidate.remitente,prioridad:candidate.prioridad,
        asunto:candidate.asunto,day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});
      seen.add(candidate.codigo);batched.push(candidate);continue;
    }
    if(!queue(candidate))continue;
    const entry={kind:'incoming_queued',codigo:candidate.codigo,remitente:candidate.remitente,prioridad:candidate.prioridad,
      day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()};
    save(entry);seen.add(candidate.codigo);queued.push(candidate);
  }
  for(const noticeCode of plan.archiveNoticeCodes){
    if(baselineSeen.has(noticeCode))continue; // cold start never acknowledges old notices
    const archivedSource=rows.find(row=>row.codigo===noticeCode&&row.asunto.startsWith('SECRETARÍA·timbre'));
    const referenced=archivedSource?parseSecretarialNoticeSubject(archivedSource.asunto):null;
    if(!archivedSource||!referenced)continue;
    const fresh=await api.get(INBOX),freshRows=correspondenceItems(fresh);
    if(!freshRows||!validNoticeStillOpen(fresh,leader,noticeCode,referenced,archivedSource.remitente))continue;
    const original=freshRows.find(row=>row.codigo===referenced&&isOwnLeaderMailbox(row.buzon,leader));
    if(!original)continue;
    const originalRead=original.leido_en!=null||original.archivado_en!=null;
    const alreadyHandled=seen.has(original.codigo);
    const planned=plan.notify.find(candidate=>candidate.noticeCode===noticeCode);
    if(!originalRead&&!alreadyHandled&&!queued.some(row=>row.codigo===original.codigo)&&!batched.some(row=>row.codigo===original.codigo)&&!low.includes(original.codigo)&&planned)continue; // no ACK when cap/queue failed
    await api.post('/correspondencia/ok',{codigo:noticeCode});
    const afterRows=correspondenceItems(await api.get(INBOX));
    if(!afterRows)throw new Error('No se pudo confirmar el OK de Correspondencia');
    const stillOpen=afterRows.find(row=>row.codigo===noticeCode&&isOwnLeaderMailbox(row.buzon,leader));
    if(stillOpen&&stillOpen.archivado_en==null)continue;
    const event={kind:'notice_acked',codigo:noticeCode,original:referenced,remitente:archivedSource.remitente,
      day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()};
    save(event);acknowledgedNotices.push(noticeCode);
  }
  for(const code of plan.rejectedNoticeCodes)save({kind:'notice_rejected',codigo:code,at:new Date(now).toISOString()});
  for(const code of capped)save({kind:'incoming_capped',codigo:code,day:dateKey(now),hour:hourKey(now),at:new Date(now).toISOString()});
  return {queued,acknowledgedNotices,rejectedNotices:plan.rejectedNoticeCodes,capped,batched,low};
}

export function checkSecretarialAcknowledgements(rowsRaw:unknown,leader:string,ledger:CorrespondenceLedgerRow[],now:number,timeoutMin:number):{
  delivered:Array<{original:string;destination:string;latencyMinutes:number}>;timeouts:Array<{original:string;destination:string;noticeCode:string}>} {
  const rows=correspondenceItems(rowsRaw);if(!rows)return {delivered:[],timeouts:[]};
  const delivered:Array<{original:string;destination:string;latencyMinutes:number}>=[],timeouts:Array<{original:string;destination:string;noticeCode:string}>=[];
  for(const notice of ledger.filter(row=>row.kind==='notice_sent'&&typeof row.original==='string'&&typeof row.noticeCode==='string'&&typeof row.destination==='string')){
    if(ledger.some(row=>(row.kind==='notice_delivered'||row.kind==='notice_timeout')&&row.noticeCode===notice.noticeCode))continue;
    const sentAt=Date.parse(notice.at??'');if(!Number.isFinite(sentAt))continue;
    const message=rows.find(row=>row.codigo===notice.noticeCode);
    if(!message)continue;
    const ack=destinationHasAcknowledged(message,notice.destination!);
    if(ack===true)delivered.push({original:notice.original!,destination:notice.destination!,latencyMinutes:Math.max(0,(now-sentAt)/60_000)});
    else if(ack===false&&now-sentAt>=timeoutMin*60_000)
      timeouts.push({original:notice.original!,destination:notice.destination!,noticeCode:notice.noticeCode!});
  }
  return {delivered,timeouts};
}
export {formatIncomingBell};
