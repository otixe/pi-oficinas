import { pruneTrash, RESERVATION_TRASH_KEEP } from './secretaria-state.ts';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface NoticeReservationRecord {
  v:1|2; code:string; pid:number; hostname:string; createdAt:string; token:string; purpose:'notice'|'recovery';
  bootId?:string|null; processStarttime?:string|null; instanceToken?:string;
}
export interface NoticeProcessIdentity {pid:number;hostname:string;bootId:string|null;processStarttime:string|null;instanceToken:string}
export type ProcStarttimeRead = {status:'ok';value:string}|{status:'missing'|'unreadable'};
export interface ProcessIdentityProbe {hostname:()=>string;bootId:()=>string|null;processStarttime:(pid:number)=>ProcStarttimeRead}
export interface NoticeReservationLease {
  stateDirectory:string; directory:string; file:string; mainFile:string; code:string; record:NoticeReservationRecord;
  kind:'created'|'owned'|'recovery'; previous?:NoticeReservationRecord; previousMtimeMs?:number;
  recoveryFile?:string;
}
export type NoticeReservationClaim =
  | {status:'acquired'; lease:NoticeReservationLease}
  | {status:'stale'; lease:NoticeReservationLease}
  | {status:'uncertain';code:string;owner?:NoticeReservationRecord;token?:string;createdAt?:string;reason:string;ageMs:number}
  | {status:'busy'; code:string; owner?:NoticeReservationRecord; token?:string; createdAt?:string; reason:string};

export const RESERVATION_IDENTITY_TIMEOUT_REASON='reservation-process-identity-unreadable-timeout';
export const RESERVATION_RECOVERY_IDENTITY_TIMEOUT_REASON='reservation-recovery-identity-unreadable-timeout';
const RESERVATION_CREATE_FLAGS=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0);
const NETWORK_FS_MAGIC=new Set([0x6969,0xff534d42,0xfe534d42,0x01021997,0x73757245,0x5346414f,0x00c36400,0x0bd00bd0,0x65735546]);
const ownUid=()=>typeof process.getuid==='function'?process.getuid():-1;
export function processStarttimeFromStat(stat:string):string|null {
  const close=stat.lastIndexOf(')');if(close<0)return null;
  const fields=stat.slice(close+1).trim().split(' '),value=fields[19];
  return typeof value==='string'&&value.length>0&&[...value].every(char=>char>='0'&&char<='9')?value:null;
}
function readBootId():string|null {
  try{const value=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();return /^[0-9a-f-]{36}$/i.test(value)?value:null;}catch{return null;}
}
function readProcStarttime(pid:number):ProcStarttimeRead {
  try{const value=processStarttimeFromStat(readFileSync(`/proc/${pid}/stat`,'utf8'));return value?{status:'ok',value}:{status:'unreadable'};}
  catch(error:any){
    if(error?.code==='ENOENT'||error?.code==='ESRCH'){
      try{process.kill(pid,0);return {status:'unreadable'};}
      catch(probeError:any){return probeError?.code==='ESRCH'?{status:'missing'}:{status:'unreadable'};}
    }
    return {status:'unreadable'};
  }
}
const INSTANCE_TOKEN=randomUUID();
const INSTANCE_IDENTITY:NoticeProcessIdentity={pid:process.pid,hostname:hostname(),bootId:readBootId(),
  processStarttime:(()=>{const value=readProcStarttime(process.pid);return value.status==='ok'?value.value:null;})(),instanceToken:INSTANCE_TOKEN};
const defaultProbe:ProcessIdentityProbe={hostname,bootId:readBootId,processStarttime:readProcStarttime};
const identityUnreadableTimeoutMs=(confirmMin:number)=>Math.max(0,confirmMin)*3*60_000;
function ownerIdentityState(record:NoticeReservationRecord,probe:ProcessIdentityProbe):'alive'|'dead'|'unreadable' {
  if(record.v!==2||!record.instanceToken||!record.bootId||!record.processStarttime)return 'unreadable';
  if(record.hostname!==probe.hostname())return 'unreadable';
  const bootId=probe.bootId();if(!bootId)return 'unreadable';if(bootId!==record.bootId)return 'dead';
  const stat=probe.processStarttime(record.pid);if(stat.status==='missing')return 'dead';
  if(stat.status==='unreadable')return 'unreadable';
  return stat.value===record.processStarttime?'alive':'dead';
}
function currentInstanceOwns(record:NoticeReservationRecord):boolean {
  return record.v===2&&record.pid===INSTANCE_IDENTITY.pid&&record.hostname===INSTANCE_IDENTITY.hostname&&
    !!INSTANCE_IDENTITY.bootId&&!!INSTANCE_IDENTITY.processStarttime&&record.bootId===INSTANCE_IDENTITY.bootId&&
    record.processStarttime===INSTANCE_IDENTITY.processStarttime&&record.instanceToken===INSTANCE_IDENTITY.instanceToken;
}
export function currentNoticeProcessIdentity():NoticeProcessIdentity {return {...INSTANCE_IDENTITY};}
function verifyDirectory(path:string,privateMode:boolean):void {
  const st=lstatSync(path);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==ownUid()||(privateMode&&(st.mode&0o077)!==0))
    throw new Error('Directorio local de reserva inseguro');
}
function fsyncDirectory(path:string):void {
  const fd=openSync(path,constants.O_RDONLY|(constants.O_DIRECTORY??0));
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
function ensureReservationDirectory(stateDirectory:string):string {
  if(!stateDirectory||!stateDirectory.startsWith('/'))throw new Error('Reserva debe quedar en state local absoluto');
  mkdirSync(stateDirectory,{recursive:true,mode:0o700});verifyDirectory(stateDirectory,false);
  const directory=join(stateDirectory,'correo-reservas');
  try{mkdirSync(directory,{mode:0o700});}catch(error:any){if(error?.code!=='EEXIST')throw error;}
  verifyDirectory(directory,true);
  const fsType=statfsSync(directory).type>>>0;
  if(NETWORK_FS_MAGIC.has(fsType))throw new Error('Reservas no permitidas en filesystem de red');
  return directory;
}
function ensureTrash(stateDirectory:string):string {
  const trash=join(stateDirectory,'.trash');
  try{mkdirSync(trash,{mode:0o700});}catch(error:any){if(error?.code!=='EEXIST')throw error;}
  verifyDirectory(trash,true);return trash;
}
function freshRecord(code:string,now:number,purpose:'notice'|'recovery'):NoticeReservationRecord {
  return {v:2,code,pid:INSTANCE_IDENTITY.pid,hostname:INSTANCE_IDENTITY.hostname,bootId:INSTANCE_IDENTITY.bootId,
    processStarttime:INSTANCE_IDENTITY.processStarttime,instanceToken:INSTANCE_IDENTITY.instanceToken,
    createdAt:new Date(now).toISOString(),token:randomUUID(),purpose};
}
function createExclusive(path:string,record:NoticeReservationRecord):void {
  const fd=openSync(path,RESERVATION_CREATE_FLAGS,0o600),bytes=Buffer.from(JSON.stringify(record)+'\n');
  try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}
  finally{closeSync(fd);}
  fsyncDirectory(dirname(path));
}
function safeRead(path:string,code:string):{record?:NoticeReservationRecord;mtimeMs:number;token:string} {
  const before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==ownUid()||(before.mode&0o077)!==0||before.size>2048)
    throw new Error('Archivo local de reserva inseguro');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const after=fstatSync(fd);
    if(!after.isFile()||after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||after.uid!==ownUid()||(after.mode&0o077)!==0||after.size>2048)
      throw new Error('Reserva cambió durante lectura');
    const text=readFileSync(fd,'utf8');
    try{
      const value=JSON.parse(text) as Partial<NoticeReservationRecord>;
      if((value.v===1||value.v===2)&&value.code===code&&Number.isSafeInteger(value.pid)&&Number(value.pid)>0&&
         typeof value.hostname==='string'&&!!value.hostname&&typeof value.createdAt==='string'&&
         Number.isFinite(Date.parse(value.createdAt))&&typeof value.token==='string'&&
         /^[0-9a-f-]{36}$/.test(value.token)&&['notice','recovery'].includes(String(value.purpose))&&
         (value.v===1||(value.v===2&&
           (value.bootId===null||typeof value.bootId==='string'&&/^[0-9a-f-]{36}$/i.test(value.bootId))&&
           (value.processStarttime===null||typeof value.processStarttime==='string'&&value.processStarttime.length>0&&[...value.processStarttime].every(char=>char>='0'&&char<='9'))&&
           typeof value.instanceToken==='string'&&/^[0-9a-f-]{36}$/.test(value.instanceToken))))
        return {record:value as NoticeReservationRecord,mtimeMs:after.mtimeMs,token:value.token};
    }catch{}
    return {mtimeMs:after.mtimeMs,token:`malformed-${after.ino}`};
  }finally{closeSync(fd);}
}
function claimRecovery(stateDirectory:string,directory:string,code:string,now:number,confirmMin:number,
  previous?:NoticeReservationRecord,previousMtimeMs?:number,probe:ProcessIdentityProbe=defaultProbe):NoticeReservationLease|undefined {
  const file=join(directory,`${code}.recovery.lock`),mainFile=join(directory,`${code}.lock`),record=freshRecord(code,now,'recovery');
  for(let attempt=0;attempt<2;attempt++){
    try{createExclusive(file,record);return {stateDirectory,directory,file,mainFile,code,record,kind:'recovery',previous,previousMtimeMs};}
    catch(error:any){if(error?.code!=='EEXIST')throw error;}
    let existing:{record?:NoticeReservationRecord;mtimeMs:number;token:string};
    try{existing=safeRead(file,code);}
    catch(error:any){
      let modified=now;try{modified=lstatSync(file).mtimeMs;}catch{}
      if(error?.code==='ENOENT')continue;
      if(now-modified<confirmMin*60_000)return undefined;
      archiveNoticeReservation(stateDirectory,file,code,'malformed-recovery-claim');continue;
    }
    const age=existing.record?Math.max(0,now-Date.parse(existing.record.createdAt)):Math.max(0,now-existing.mtimeMs);
    if(!existing.record){
      if(age<confirmMin*60_000)return undefined;
      archiveNoticeReservation(stateDirectory,file,code,'malformed-recovery-claim');continue;
    }
    const ownerState=existing.record?ownerIdentityState(existing.record,probe):'dead';
    if(ownerState==='alive'||(ownerState==='unreadable'&&age<identityUnreadableTimeoutMs(confirmMin)))return undefined;
    if(ownerState==='unreadable')return undefined; // A PID whose identity is unreadable is never stolen, even after alert timeout.
    archiveNoticeReservation(stateDirectory,file,code,'stale-recovery-claim');
  }
  return undefined;
}
export function acquireNoticeReservation(stateDirectory:string,code:string,now:number,confirmMin:number,
  probe:ProcessIdentityProbe=defaultProbe):NoticeReservationClaim {
  if(!/^[0-9a-f]{16}(?:\.[1-9][0-9]*)?$/.test(code))throw new Error('Código inválido para reserva local');
  const directory=ensureReservationDirectory(stateDirectory),file=join(directory,`${code}.lock`),record=freshRecord(code,now,'notice');
  try{createExclusive(file,record);return {status:'acquired',lease:{stateDirectory,directory,file,mainFile:file,code,record,kind:'created'}};}
  catch(error:any){if(error?.code!=='EEXIST')throw error;}
  let existing:{record?:NoticeReservationRecord;mtimeMs:number;token:string};
  try{existing=safeRead(file,code);}
  catch(error:any){if(error?.code==='ENOENT'){
      try{createExclusive(file,record);return {status:'acquired',lease:{stateDirectory,directory,file,mainFile:file,code,record,kind:'created'}};}
      catch(retry:any){if(retry?.code!=='EEXIST')throw retry;return {status:'busy',code,reason:'reservation-create-raced'};}
    }throw error;}
  const ageMs=Math.max(0,now-(existing.record?Date.parse(existing.record.createdAt):existing.mtimeMs));
  if(existing.record){
    const state=ownerIdentityState(existing.record,probe);
    if(state==='alive'&&currentInstanceOwns(existing.record))
      return {status:'acquired',lease:{stateDirectory,directory,file,mainFile:file,code,record:existing.record,kind:'owned'}};
    if(state==='alive')return {status:'busy',code,owner:existing.record,token:existing.token,
      createdAt:existing.record.createdAt,reason:'reserved-by-live-process'};
    if(state==='unreadable'){
      if(ageMs<identityUnreadableTimeoutMs(confirmMin))return {status:'busy',code,owner:existing.record,token:existing.token,
        createdAt:existing.record.createdAt,reason:'reservation-process-identity-unreadable'};
      return {status:'uncertain',code,owner:existing.record,token:existing.token,createdAt:existing.record.createdAt,
        reason:RESERVATION_IDENTITY_TIMEOUT_REASON,ageMs};
    }
  }else if(ageMs<confirmMin*60_000){
    return {status:'busy',code,token:existing.token,createdAt:new Date(existing.mtimeMs).toISOString(),reason:'malformed-reservation-within-grace'};
  }
  const recovery=claimRecovery(stateDirectory,directory,code,now,confirmMin,existing.record,existing.mtimeMs,probe);
  if(!recovery){
    const recoveryFile=join(directory,`${code}.recovery.lock`);
    try{
      const pendingRecovery=safeRead(recoveryFile,code),recoveryAge=Math.max(0,now-(pendingRecovery.record?Date.parse(pendingRecovery.record.createdAt):pendingRecovery.mtimeMs));
      if(pendingRecovery.record&&ownerIdentityState(pendingRecovery.record,probe)==='unreadable'&&
         recoveryAge>=identityUnreadableTimeoutMs(confirmMin))
        return {status:'uncertain',code,owner:pendingRecovery.record,token:pendingRecovery.token,
          createdAt:pendingRecovery.record.createdAt,reason:RESERVATION_RECOVERY_IDENTITY_TIMEOUT_REASON,ageMs:recoveryAge};
    }catch(error:any){if(error?.code!=='ENOENT')throw error;}
    return {status:'busy',code,owner:existing.record,token:existing.token,
      createdAt:existing.record?.createdAt??new Date(existing.mtimeMs).toISOString(),reason:'reservation-recovery-owned-by-other'};
  }
  let current:{record?:NoticeReservationRecord;mtimeMs:number;token:string};
  try{current=safeRead(file,code);}catch(error:any){
    archiveNoticeReservation(stateDirectory,recovery.file,code,'recovery-main-missing');
    return {status:'busy',code,reason:'reservation-changed-during-recovery'};
  }
  if(current.token!==existing.token){
    archiveNoticeReservation(stateDirectory,recovery.file,code,'recovery-main-changed');
    return {status:'busy',code,owner:current.record,token:current.token,reason:'reservation-owner-changed'};
  }
  return {status:'stale',lease:{...recovery,kind:'recovery',mainFile:file,previous:existing.record,previousMtimeMs:existing.mtimeMs}};
}
export function archiveNoticeReservation(stateDirectory:string,file:string,code:string,reason:string):string|undefined {
  let st;try{st=lstatSync(file);}catch(error:any){if(error?.code==='ENOENT')return undefined;throw error;}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==ownUid()||(st.mode&0o077)!==0||st.size>2048)
    throw new Error('No se puede archivar una reserva insegura');
  const trash=ensureTrash(stateDirectory),safeReason=reason.replace(/[^a-z0-9_-]/gi,'_').slice(0,40)||'archived';
  const target=join(trash,`correo-reserva-${code}-${safeReason}-${Date.now()}-${randomUUID()}.lock`);
  renameSync(file,target);fsyncDirectory(trash);
  // F5 (a82e464f): archived reservations are bounded (the most recent ones; the rest are deleted).
  pruneTrash(trash,'correo-reserva-',RESERVATION_TRASH_KEEP);
  return target;
}
export function reservationAgeMs(record:NoticeReservationRecord|undefined,mtimeMs:number|undefined,now:number):number {
  const created=record?Date.parse(record.createdAt):mtimeMs;
  return Number.isFinite(created)?Math.max(0,now-created!):Number.MAX_SAFE_INTEGER;
}
export function reservationRecordDate(record:NoticeReservationRecord|undefined,mtimeMs:number|undefined):string {
  if(record&&Number.isFinite(Date.parse(record.createdAt)))return record.createdAt;
  return new Date(mtimeMs??Date.now()).toISOString();
}
export function reservationOwnerInfo(record:NoticeReservationRecord|undefined):{pid?:number;hostname?:string;token?:string;bootId?:string|null;processStarttime?:string|null;instanceToken?:string} {
  return record?{pid:record.pid,hostname:record.hostname,token:record.token,bootId:record.bootId,
    processStarttime:record.processStarttime,instanceToken:record.instanceToken}:{};
}
