export type MailPriority='urgente'|'medio'|'bajo';
export interface CorrespondenceRow {
  codigo:string; raiz?:string; remitente:string; prioridad:MailPriority; asunto:string; buzon:string;
  leido_en?:string|null; archivado_en?:string|null; creado_en?:string; created_at?:string; sin_reaccion?:unknown; reacciones?:unknown; reacciones_activas?:unknown;
}
export interface IncomingOriginal {codigo:string;remitente:string;prioridad:MailPriority;asunto:string;noticeCode?:string;noticeSubject?:string}
const CODE=/^[0-9a-f]{16}$/;
const MESSAGE_CODE=/^[0-9a-f]{16}(?:\.[1-9][0-9]*)?$/;
const AGENT=/^[a-z][a-z0-9-]{0,39}$/;
const PRIORITIES=new Set<MailPriority>(['urgente','medio','bajo']);
function extractRawItems(raw:unknown):unknown[]|null {
  let value:any=raw;
  if(value&&typeof value==='object'&&'result'in value)value=value.result;
  if(typeof value==='string')try{value=JSON.parse(value)}catch{return null;}
  if(!value||typeof value!=='object'||!Array.isArray(value.items))return null;
  return value.items;
}
/** Projects only non-body metadata. Preview and contents are intentionally discarded. */
export function correspondenceItems(raw:unknown):CorrespondenceRow[]|null {
  const items=extractRawItems(raw);if(!items)return null;
  const out:CorrespondenceRow[]=[];
  for(const item of items){
    if(!item||typeof item!=='object')return null;
    const row=item as any;
    if(typeof row.codigo!=='string'||!MESSAGE_CODE.test(row.codigo)||typeof row.remitente!=='string'||
       typeof row.prioridad!=='string'||!PRIORITIES.has(row.prioridad)||typeof row.asunto!=='string'||typeof row.buzon!=='string')return null;
    if((row.raiz!=null&&(typeof row.raiz!=='string'||!CODE.test(row.raiz)))||
       (row.leido_en!=null&&typeof row.leido_en!=='string')||(row.archivado_en!=null&&typeof row.archivado_en!=='string'))return null;
    out.push({codigo:row.codigo,...(row.raiz?{raiz:row.raiz}:{}),remitente:row.remitente,prioridad:row.prioridad,
      asunto:row.asunto,buzon:row.buzon,leido_en:row.leido_en??null,archivado_en:row.archivado_en??null,
      ...(typeof row.creado_en==='string'?{creado_en:row.creado_en}:{}),...(typeof row.created_at==='string'?{created_at:row.created_at}:{}),
      ...(row.sin_reaccion!==undefined?{sin_reaccion:row.sin_reaccion}:{}),
      ...(row.reacciones!==undefined?{reacciones:row.reacciones}:{}),
      ...(row.reacciones_activas!==undefined?{reacciones_activas:row.reacciones_activas}:{})});
  }
  return out;
}
function addressParts(value:string):{leader:string;member?:string}|null {
  if(typeof value!=='string')return null;
  const raw=value.trim().replace(/^@/,'');
  const [leader,member,...rest]=raw.split('/');
  if(!AGENT.test(leader)||rest.length|| (member!==undefined&&!AGENT.test(member)&&member!=='*'))return null;
  return {leader,...(member!==undefined?{member}:{})};
}
export function isLeaderIdentity(value:string,ownLeader?:string):boolean {
  const address=addressParts(value);if(!address||address.leader===(process.env.PI_OFICINAS_HUMAN || 'human')||address.leader===ownLeader)return false;
  return address.member===undefined||address.member===address.leader;
}
export function isOwnLeaderMailbox(value:string,leader:string):boolean {
  const address=addressParts(value);return !!address&&address.leader===leader&&
    (address.member===undefined||address.member===leader);
}
export function isLeaderMailbox(value:string,leader:string):boolean {
  const address=addressParts(value);return !!address&&address.leader===leader&&
    (address.member===undefined||address.member===leader);
}
export function sameCorrespondenceSender(a:string,b:string):boolean{return sameActor(a,b);}
export function leaderRegistryCandidate(value:string,ownLeader:string):string|null {
  const address=addressParts(value);if(!address||address.leader===(process.env.PI_OFICINAS_HUMAN || 'human')||address.leader===ownLeader||
    (address.member!==undefined&&address.member!==address.leader))return null;
  return address.leader;
}
export function leaderNamesFromRegistry(raw:unknown):Set<string>|null {
  const agents=Array.isArray(raw)?raw:(raw&&typeof raw==='object'&&Array.isArray((raw as any).agents)?(raw as any).agents:null);
  if(!agents)return null;
  const leaders=new Set<string>();
  for(const agent of agents){
    if(!agent||typeof agent!=='object'||!AGENT.test(agent.name)||agent.active===false)continue;
    const name=String(agent.name).toLowerCase(),role=typeof agent.role==='string'?agent.role.toLowerCase():'',team=agent.team;
    const parts=typeof agent.source_path==='string'?agent.source_path.split('/'):[];
    const rootSoul=parts.length===4&&parts[0]==='50 Agents'&&parts[1].toLowerCase()===name&&parts[2]==='Vigente'&&parts[3]==='SOUL.md';
    if(role.includes('leader')||role.includes('orchestrator')||team===name||rootSoul)leaders.add(name);
  }
  return leaders;
}
export function externalLeaderRecipients(raw:unknown,team:{lider:string;oficinas?:string[]}):string[] {
  if(typeof raw!=='string'||raw.length>4000)return [];
  const own=new Set([team.lider,...(team.oficinas??[]),(process.env.PI_OFICINAS_HUMAN || 'human')]);
  const result=new Set<string>();
  for(const part of raw.split(',')){
    const address=addressParts(part);if(!address||own.has(address.leader))continue;
    if(address.member!==undefined&&address.member!==address.leader)continue; // subagents and wildcards are not leaders
    result.add(address.leader);
  }
  return [...result].sort();
}
export interface SecretarialNotice {codigo:string;remitente:string;prioridad:MailPriority}
export function secretarialNoticeSubject(code:string):string {
  if(!MESSAGE_CODE.test(code))throw new Error('Código de Correspondencia inválido');
  return `SECRETARÍA·timbre ${code}`;
}
export function parseSecretarialNoticeSubject(subject:unknown):string|null {
  if(typeof subject!=='string')return null;
  const m=/^SECRETARÍA·timbre ([0-9a-f]{16}(?:\.[1-9][0-9]*)?)$/.exec(subject);return m?.[1]??null;
}
export function secretarialNoticeContent(notice:SecretarialNotice):string {
  if(!MESSAGE_CODE.test(notice.codigo)||!AGENT.test(notice.remitente)||!PRIORITIES.has(notice.prioridad))throw new Error('Aviso Secretaría inválido');
  return `${JSON.stringify({v:1,kind:'correspondencia',codigo:notice.codigo,remitente:notice.remitente,prioridad:notice.prioridad})}\n`+
    `Aviso automático de la secretaría de @${notice.remitente}: tenés la Correspondencia ${notice.codigo} — leela con cb_correspondencia_leer`;
}
export function formatIncomingBell(row:Pick<IncomingOriginal,'codigo'|'remitente'|'prioridad'>):string {
  if(!MESSAGE_CODE.test(row.codigo)||!PRIORITIES.has(row.prioridad)||!isLeaderIdentity(row.remitente))throw new Error('Entrega de líder inválida');
  const sender=addressParts(row.remitente)!.leader;
  return `📨 Correspondencia de @${sender} (${row.prioridad}) ${row.codigo} — leela con cb_correspondencia_leer`;
}
/** Un timbre, N medios pendientes en lote (código, remitente, asunto). Incluye un conteo de bajos
 * omitidos si lowCount>0 ('+N bajos'), para que ninguno de esos quede invisible aunque no timbren
 * por su cuenta (tarea 277eb7cf: nada se pierde, sólo se agrupa o se difiere). */
export function formatBatchedBell(rows:Pick<IncomingOriginal,'codigo'|'remitente'|'asunto'>[],lowCount=0):string {
  if(!rows.length)throw new Error('Lote de Correspondencia vacío');
  for(const row of rows)if(!MESSAGE_CODE.test(row.codigo)||!isLeaderIdentity(row.remitente)||typeof row.asunto!=='string')throw new Error('Lote de Correspondencia inválido');
  if(!Number.isInteger(lowCount)||lowCount<0)throw new Error('Conteo de bajos inválido');
  const lines=rows.map(row=>`• @${addressParts(row.remitente)!.leader} ${row.codigo}: ${row.asunto}`);
  const suffix=lowCount>0?`\n+${lowCount} bajos`:'';
  return `📨 Correspondencia (medio) — ${rows.length} pendiente${rows.length===1?'':'s'}, leélas con cb_correspondencia_leer:\n${lines.join('\n')}${suffix}`;
}
export function extractSuccessfulCode(content:unknown,toolName=''):string|null {
  const responder=/(?:cb_)?correspondencia_responder$/.test(toolName),codePattern=responder?MESSAGE_CODE:CODE;
  if(content&&typeof content==='object'&&!Array.isArray(content)){
    const value=content as any;
    for(const key of ['codigo','codigo_original','codigo_mensaje','code'])if(typeof value[key]==='string'&&codePattern.test(value[key]))return value[key];
    if(value.result&&typeof value.result==='object')return extractSuccessfulCode(value.result,toolName);
  }
  const texts=Array.isArray(content)?content.filter((row:any)=>row?.type==='text'&&typeof row.text==='string').map((row:any)=>row.text):[];
  if(!texts.length)return null;
  const candidates:string[]=[],add=(value:any)=>{if(typeof value==='string'&&codePattern.test(value))candidates.push(value)};
  const tryJson=(raw:string)=>{try{const value=JSON.parse(raw);if(value&&typeof value==='object'){for(const key of ['codigo','codigo_original','codigo_mensaje','code'])add(value[key]);if(typeof value.result==='string')tryJson(value.result)}}catch{}};
  for(const text of texts)tryJson(text);
  const combined=texts.join('\n');
  const first=combined.split(/\r?\n/).find(line=>line.trim().length>0)?.trim()??'';
  if(combined.split(/\r?\n/).filter(line=>line.trim()).length!==1)return null;
  const publication=/^Correspondencia\s+([0-9a-f]{16})\s+publicada\s+por\b[^\r\n]*$/i.exec(first);
  const response=/^Respuesta\s+([0-9a-f]{16}\.[1-9][0-9]*)\s+en raíz\s+([0-9a-f]{16})\s+->[^\r\n]*$/i.exec(first);
  if(responder){if(response)add(response[1]);}else if(publication)add(publication[1]);
  const unique=[...new Set(candidates)];return unique.length===1?unique[0]:null;
}
function unread(row:CorrespondenceRow):boolean{return row.leido_en==null&&row.archivado_en==null;}
function sameActor(a:string,b:string):boolean {
  const left=addressParts(a),right=addressParts(b);return !!left&&!!right&&left.leader===right.leader&&
    (left.member===undefined||left.member===left.leader)&&(right.member===undefined||right.member===right.leader);
}
export interface InboxPlan {notify:IncomingOriginal[];archiveNoticeCodes:string[];rejectedNoticeCodes:string[];rejectedOriginalCodes:string[]}
/** Matches fixed subject -> original code -> same leader sender. Never reads body or preview. */
export function planIncoming(raw:unknown,leader:string,fallback=true,seenOriginals:ReadonlySet<string>=new Set(),knownLeaders?:ReadonlySet<string>):InboxPlan|null {
  if(!AGENT.test(leader))return null;
  const isExternalLeader=(sender:string)=>{
    const candidate=leaderRegistryCandidate(sender,leader);
    return !!candidate&&(knownLeaders?knownLeaders.has(candidate):isLeaderIdentity(sender,leader));
  };
  const rows=correspondenceItems(raw);if(!rows)return null;
  const notify=new Map<string,IncomingOriginal>(),archiveNoticeCodes:string[]=[],rejectedNoticeCodes:string[]=[],rejectedOriginalCodes=new Set<string>();
  const ownRows=rows.filter(row=>isOwnLeaderMailbox(row.buzon,leader));
  for(const notice of ownRows.filter(unread)){
    if(notice.asunto.startsWith('SECRETARÍA·timbre')){
      const originalCode=parseSecretarialNoticeSubject(notice.asunto);
      if(!originalCode||!isExternalLeader(notice.remitente)) {
        const prefixCode=/^SECRETARÍA·timbre ([0-9a-f]{16}(?:\.[1-9][0-9]*)?)/.exec(notice.asunto)?.[1];
        if(prefixCode){rejectedOriginalCodes.add(prefixCode);notify.delete(prefixCode);}
        rejectedNoticeCodes.push(notice.codigo);continue;
      }
      const original=ownRows.find(row=>row.codigo===originalCode&&row.codigo!==notice.codigo);
      if(!original||!sameActor(original.remitente,notice.remitente)) {
        rejectedOriginalCodes.add(originalCode);notify.delete(originalCode);rejectedNoticeCodes.push(notice.codigo);continue;
      }
      if(original.archivado_en!=null){archiveNoticeCodes.push(notice.codigo);continue;}
      if(original.leido_en!=null){archiveNoticeCodes.push(notice.codigo);continue;}
      archiveNoticeCodes.push(notice.codigo);
      if(!seenOriginals.has(original.codigo))notify.set(original.codigo,{codigo:original.codigo,remitente:original.remitente,prioridad:original.prioridad,asunto:original.asunto,noticeCode:notice.codigo,noticeSubject:notice.asunto});
      continue;
    }
    if(fallback&&isExternalLeader(notice.remitente)&&unread(notice)&&!seenOriginals.has(notice.codigo)&&
       !rejectedOriginalCodes.has(notice.codigo)&&!notify.has(notice.codigo))
      notify.set(notice.codigo,{codigo:notice.codigo,remitente:notice.remitente,prioridad:notice.prioridad,asunto:notice.asunto});
  }
  return {notify:[...notify.values()],archiveNoticeCodes:[...new Set(archiveNoticeCodes)],rejectedNoticeCodes:[...new Set(rejectedNoticeCodes)],
    rejectedOriginalCodes:[...rejectedOriginalCodes]};
}
export function originalStillUnread(raw:unknown,leader:string,code:string,sender:string):boolean {
  if(!MESSAGE_CODE.test(code)||!isLeaderIdentity(sender,leader))return false;
  const rows=correspondenceItems(raw);if(!rows)return false;
  const original=rows.find(row=>row.codigo===code&&isOwnLeaderMailbox(row.buzon,leader));
  return !!original&&unread(original)&&sameActor(original.remitente,sender);
}
export function validNoticeStillOpen(raw:unknown,leader:string,noticeCode:string,originalCode:string,sender:string):boolean {
  if(!CODE.test(noticeCode)||!MESSAGE_CODE.test(originalCode)||!isLeaderIdentity(sender,leader))return false;
  const rows=correspondenceItems(raw);if(!rows)return false;
  const notice=rows.find(row=>row.codigo===noticeCode&&isOwnLeaderMailbox(row.buzon,leader));
  const original=rows.find(row=>row.codigo===originalCode&&isOwnLeaderMailbox(row.buzon,leader));
  return !!notice&&unread(notice)&&parseSecretarialNoticeSubject(notice.asunto)===originalCode&&
    sameActor(notice.remitente,sender)&&!!original&&sameActor(original.remitente,sender);
}
export interface OutgoingContext {codigo:string;prioridad:MailPriority;destinos:string[]}
/** Resolves a successful leader send/reply against its own mailbox metadata. */
export function resolveOutgoingContext(raw:unknown,toolName:string,input:any,output:unknown,leader:string,ownOffices:readonly string[]=[]):OutgoingContext|null {
  const rows=correspondenceItems(raw);if(!rows||!AGENT.test(leader)||!/(?:cb_)?correspondencia_(?:publicar|responder)$/.test(toolName))return null;
  const own=new Set([leader,...ownOffices,(process.env.PI_OFICINAS_HUMAN || 'human')]);
  const publishedCode=extractSuccessfulCode(output,toolName);
  if(!publishedCode)return null;
  const matches=rows.filter(row=>row.codigo===publishedCode&&sameActor(row.remitente,leader));
  if(!matches.length)return null;
  const sourceRow=matches[0],threadRoot=sourceRow.raiz??sourceRow.codigo;
  const threadRows=rows.filter(row=>sameActor(row.remitente,leader)&&(row.codigo===publishedCode||row.raiz===threadRoot));
  const priority=PRIORITIES.has(input?.prioridad)?input.prioridad:sourceRow.prioridad;
  const destinos=[...new Set(threadRows.map(row=>addressParts(row.buzon)).filter((x):x is {leader:string;member?:string}=>!!x&&!own.has(x.leader)&&
    (x.member===undefined||x.member===x.leader)).map(x=>x.leader))].sort();
  return {codigo:publishedCode,prioridad:priority,destinos};
}
export function coldStartSeenCodes(raw:unknown,leader:string,activatedAt:number):string[]|null {
  if(!Number.isFinite(activatedAt))return null;
  const rows=correspondenceItems(raw);if(!rows)return null;
  return [...new Set(rows.filter(row=>isOwnLeaderMailbox(row.buzon,leader)).filter(row=>{
    const created=Date.parse(row.creado_en??row.created_at??'');return !Number.isFinite(created)||created<=activatedAt;
  }).map(row=>row.codigo))];
}
export function incomingNoticeLedgerKey(code:string):string{return `incoming:${code}`;}
export function outgoingNoticeLedgerKey(code:string,destination:string):string{return `outgoing:${code}:${destination}`;}
export function destinationHasAcknowledged(row:CorrespondenceRow,destination:string):boolean|null {
  const expected=addressParts(destination);if(!expected)return null;
  const matches=(value:unknown)=>{
    if(typeof value!=='string')return false;
    const parsed=addressParts(value);return !!parsed&&parsed.leader===expected.leader&&
      (parsed.member===undefined||parsed.member===parsed.leader);
  };
  if(Array.isArray(row.sin_reaccion))return !row.sin_reaccion.some(matches);
  const reactions=Array.isArray(row.reacciones_activas)?row.reacciones_activas:Array.isArray(row.reacciones)?row.reacciones:undefined;
  if(!reactions)return null;
  return reactions.some((reaction:any)=>matches(reaction?.buzon??reaction?.remitente??reaction?.agente)&&
    (reaction?.tipo==='ok'||reaction?.kind==='ok'||reaction?.accion==='ok'||reaction?.emoji==='👍'));
}
export function formatSenderTimeout(destination:string,code:string,minutes:number):string {
  const address=addressParts(destination);if(!address||!MESSAGE_CODE.test(code)||!Number.isInteger(minutes)||minutes<1)throw new Error('Timeout de acuse inválido');
  return `Sin acuse de la secretaría de @${address.leader} para ${code} en ${minutes} min — leela en el tablero/Correspondencia`;
}
/** Epoch ms del ÚLTIMO mensaje de USUARIO (nunca de la propia Secretaría: timbres empiezan con
 * 🔔/📨) en 'entries' (shape de ctx.sessionManager.getBranch()), o null si no hay ninguno. Esto es
 * lo que la tarea 277eb7cf llama 'the human está conversando': NUNCA se manda el lote de medios
 * mientras ese mensaje tiene menos de correo_silencio_humano_min minutos (ver secretaria.ts). */
export function lastUserMessageAtMs(entries:ReadonlyArray<{type:string;message?:{role?:string;content?:unknown;timestamp?:number}}>):number|null {
  if(!Array.isArray(entries))return null;
  let latest:number|null=null;
  for(const entry of entries){
    if(entry?.type!=='message'||entry.message?.role!=='user')continue;
    const content=entry.message.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string').map((part:any)=>part.text).join('\n'):'';
    if(text.startsWith('🔔')||text.startsWith('📨'))continue; // avisos de la propia Secretaría, nunca cuentan como the human hablando
    const at=entry.message.timestamp;
    if(typeof at==='number'&&Number.isFinite(at)&&(latest===null||at>latest))latest=at;
  }
  return latest;
}
/** true si the human habló (mensaje de usuario real, no timbre) hace menos de 'silenceMin' minutos. */
export function humanRecentlyActive(entries:ReadonlyArray<{type:string;message?:{role?:string;content?:unknown;timestamp?:number}}>,now:number,silenceMin:number):boolean {
  const last=lastUserMessageAtMs(entries);
  return last!==null&&now-last<silenceMin*60_000;
}
