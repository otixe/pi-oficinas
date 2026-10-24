import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { contextPendingKey, parseContextNotice, formatContextNotice, type ContextNotice } from './context-relaunch.ts';

export const PENDING_NAME='secretaria-context-pending.json';
function regular(path:string) {
  const s=lstatSync(path);
  if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.uid!==process.getuid?.() || (s.mode&0o077)!==0 || s.size>16_384)
    throw new Error('Cola contexto insegura');
  return s;
}
function dir(path:string) {
  if(!isAbsolute(path))throw new Error('Ruta no absoluta');
  try {mkdirSync(path,{mode:0o700});}catch(e:any){if(e?.code!=='EEXIST')throw e;}
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.())throw new Error('Directorio de cola inseguro');
}
export function readPendingContext(leaderBody:string, offices:readonly string[]):Map<string,ContextNotice> {
  const file=join(leaderBody,'state',PENDING_NAME);
  try {
    regular(file);
    const rows=JSON.parse(readFileSync(file,'utf8'));
    if(!Array.isArray(rows)||rows.length>50)throw new Error('Cola contexto inválida');
    const pending=new Map<string,ContextNotice>();
    for(const row of rows){
      const text=typeof row?.office==='string'&&(typeof row?.percent==='number'||row?.percent===null)&&typeof row?.taskId==='string'
        ? formatContextNotice(row as ContextNotice):'';
      const n=parseContextNotice(text,offices);
      if(!n||(n.percent!==null && n.percent<70)||JSON.stringify(row)!==JSON.stringify(n)||pending.has(contextPendingKey(n)))throw new Error('Cola contexto inválida');
      pending.set(contextPendingKey(n),n);
    }
    return pending;
  }catch(e:any){if(e?.code==='ENOENT')return new Map();throw e;}
}
/** Atomic update after leader consumes one notice; old bytes remain in private .trash. */
export function writePendingContext(leaderBody:string, pending:ReadonlyMap<string,ContextNotice>, offices:readonly string[]):void {
  if(!isAbsolute(leaderBody)||pending.size>50)throw new Error('Cola contexto inválida');
  const state=join(leaderBody,'state'),trash=join(state,'.trash');dir(state);dir(trash);
  const rows:ContextNotice[]=[];
  for(const [key,value] of pending){
    const n=parseContextNotice(formatContextNotice(value),offices);
    if(!n||(n.percent!==null && n.percent<70)||key!==contextPendingKey(n))throw new Error('Cola contexto inválida');
    rows.push(n);
  }
  const target=join(state,PENDING_NAME),temp=join(state,`${PENDING_NAME}.${randomUUID()}.tmp`);
  try{regular(target);}catch(e:any){if(e?.code!=='ENOENT')throw e;}
  let fd:number|undefined;
  try {
    fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeSync(fd,JSON.stringify(rows)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    try{regular(target);linkSync(target,join(trash,`context-pending-old-${randomUUID()}.json`));}
    catch(e:any){if(e?.code!=='ENOENT')throw e;}
    renameSync(temp,target);
  }catch(e){if(fd!==undefined)closeSync(fd);
    try{renameSync(temp,join(trash,`context-pending-failed-${randomUUID()}.tmp`));}catch(ignore:any){if(ignore?.code!=='ENOENT')throw ignore;}
    throw e;
  }
}
