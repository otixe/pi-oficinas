import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function assertPrivateRegular(path:string,maxBytes:number){
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>maxBytes)
    throw new Error('Estado local inseguro');
  return st;
}
export function readPrivateJson<T>(path:string,fallback:T,maxBytes=1024*1024):T {
  let fd:number|undefined;
  try{
    const before=assertPrivateRegular(path,maxBytes);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const actual=fstatSync(fd);if(!actual.isFile()||actual.ino!==before.ino||actual.dev!==before.dev||actual.nlink!==1||actual.uid!==process.getuid?.()||(actual.mode&0o077)!==0||actual.size>maxBytes)
      throw new Error('Estado local cambió durante lectura');
    return JSON.parse(readFileSync(fd,'utf8')) as T;
  }catch(e:any){if(e?.code==='ENOENT')return fallback;throw e;}finally{if(fd!==undefined)closeSync(fd);}
}
export function writePrivateJson(path:string,value:unknown,maxBytes=1024*1024):void {
  const dir=dirname(path),trash=join(dir,'.trash');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const dirStat=lstatSync(dir);if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||dirStat.uid!==process.getuid?.())throw new Error('Directorio de estado inseguro');
  try{mkdirSync(trash,{mode:0o700});}catch(e:any){if(e?.code!=='EEXIST')throw e;}
  const trashStat=lstatSync(trash);if(!trashStat.isDirectory()||trashStat.isSymbolicLink()||trashStat.uid!==process.getuid?.())throw new Error('Directorio .trash inseguro');
  const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>maxBytes)throw new Error('Estado excede límite');
  try{assertPrivateRegular(path,maxBytes);}catch(e:any){if(e?.code!=='ENOENT')throw e;}
  const temp=join(dir,`.${basename(path)}.${randomUUID()}.tmp`),fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  try{
    try{assertPrivateRegular(path,maxBytes);linkSync(path,join(trash,`${basename(path)}-${randomUUID()}.bak`));}
    catch(e:any){if(e?.code!=='ENOENT')throw e;}
    renameSync(temp,path);
  }catch(e){try{renameSync(temp,join(trash,`${basename(path)}-failed-${randomUUID()}.tmp`));}catch{}throw e;}
  // F5: every write leaves a .bak in .trash; without a ceiling it grew forever (one per sweep).
  pruneTrash(trash,`${basename(path)}-`,TRASH_KEEP_PER_FILE);
}
export function appendPrivateJsonLine(path:string,value:unknown):void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw new Error('Ledger privado inseguro');
    const line=JSON.stringify(value)+'\n';let offset=0;const bytes=Buffer.from(line);
    while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);
    fsyncSync(fd);
  }finally{closeSync(fd);}
}
export function quarantinePrivateFile(path:string):string {
  const dir=dirname(path),trash=join(dir,'.trash');
  const st=assertPrivateRegular(path,Number.MAX_SAFE_INTEGER);
  if(st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw new Error('Ledger F4 inseguro; non-destructive quarantine refused');
  try{mkdirSync(trash,{mode:0o700});}catch(e:any){if(e?.code!=='EEXIST')throw e;}
  const t=lstatSync(trash);if(!t.isDirectory()||t.isSymbolicLink()||t.uid!==process.getuid?.())throw new Error('Directorio de cuarentena inseguro');
  const destination=join(trash,`${basename(path)}-corrupt-${randomUUID()}.jsonl`);
  renameSync(path,destination);return destination;
}
/** Pone en cuarentena un archivo que YA SE SABE inseguro o corrupto (permisos abiertos,
 *  symlink, hardlinks, JSON malformado o de forma inválida) SIN exigir que primero esté
 *  en 0600 — a diferencia de quarantinePrivateFile, que rechaza mover un archivo que no
 *  cumpla ya esa condición (y por eso no sirve justamente para el caso 0644 que motiva
 *  esta función). Nunca sigue el symlink: lo mueve tal cual, nunca lo abre. No lanza si
 *  el archivo no existe (null). El nombre de destino no asume extensión .jsonl: usa el
 *  basename real, para servir también a estados .json de una sola línea.
 */
export function quarantineUnsafeFile(path:string):string|null {
  const dir=dirname(path),trash=join(dir,'.trash');
  try{lstatSync(path);}catch(e:any){if(e?.code==='ENOENT')return null;throw e;}
  mkdirSync(dir,{recursive:true,mode:0o700});
  try{mkdirSync(trash,{mode:0o700});}catch(e:any){if(e?.code!=='EEXIST')throw e;}
  const t=lstatSync(trash);if(!t.isDirectory()||t.isSymbolicLink()||t.uid!==process.getuid?.())throw new Error('Directorio de cuarentena inseguro');
  const destination=join(trash,`${basename(path)}-corrupt-${randomUUID()}`);
  renameSync(path,destination);return destination;
}
export function readPrivateJsonLines(path:string,maxBytes=4*1024*1024):any[] {
  let fd:number|undefined;
  try{
    const before=assertPrivateRegular(path,maxBytes);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);
    if(st.ino!==before.ino||st.dev!==before.dev||st.nlink!==1)throw new Error('Ledger privado cambió');
    return readFileSync(fd,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  }catch(e:any){if(e?.code==='ENOENT')return [];throw e;}finally{if(fd!==undefined)closeSync(fd);}
}

// ---------------------------------------------------------------------------------------------
// F5 (a82e464f, 2026-10-07): bounded local state. It is an operational exception to the directive
// «Cerebro siempre, nada local» (see templates/oficina/ESTADO-LOCAL-SECRETARIA.md). These are
// coordination files (locks, dedupe, ledger) that must stay bounded, 0600/0700, and never carry
// free text or credentials.
// ---------------------------------------------------------------------------------------------

export const TRASH_KEEP_PER_FILE = 20;
export const RESERVATION_TRASH_KEEP = 200;
export const JSONL_MAX_BYTES = 1024 * 1024;

/** In dir/.trash keeps only the `keep` most recent entries whose name starts with `prefix`; the rest are deleted. */
export function pruneTrash(trash: string, prefix: string, keep: number): number {
  let names: string[];
  try { names = readdirSync(trash); } catch (e: any) { if (e?.code === 'ENOENT') return 0; throw e; }
  const own = names.filter(name => name.startsWith(prefix)).map(name => {
    const path = join(trash, name);
    try { const st = lstatSync(path); return st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid?.() ? { path, mtime: st.mtimeMs } : null; }
    catch { return null; }
  }).filter((x): x is { path: string; mtime: number } => !!x).sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1));
  let removed = 0;
  for (const old of own.slice(keep)) { try { unlinkSync(old.path); removed++; } catch { /* best-effort */ } }
  return removed;
}

/** If the jsonl exceeds maxBytes, it becomes <path>.1 (overwrites the previous generation) and starts empty. */
export function rotateJsonlIfLarge(path: string, maxBytes = JSONL_MAX_BYTES): boolean {
  let st;
  try { st = lstatSync(path); } catch (e: any) { if (e?.code === 'ENOENT') return false; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error('jsonl local inseguro; no se rota');
  if (st.size <= maxBytes) return false;
  renameSync(path, `${path}.1`);
  return true;
}

/** Appends a line to a private jsonl: creates 0600, and if it already existed with an open mode, closes it to 0600. */
export function appendPrivateLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) throw new Error('jsonl local inseguro');
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally { closeSync(fd); }
}

/** Atomic rewrite of a private jsonl (temp 0600 + rename); the previous copy goes to .trash, bounded. */
export function rewritePrivateJsonLines(path: string, rows: unknown[]): void {
  const dir = dirname(path), trash = join(dir, '.trash');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { mkdirSync(trash, { mode: 0o700 }); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, rows.map(row => JSON.stringify(row) + '\n').join('')); fsyncSync(fd); } finally { closeSync(fd); }
  try { assertPrivateRegular(path, Number.MAX_SAFE_INTEGER); linkSync(path, join(trash, `${basename(path)}-${randomUUID()}.bak`)); }
  catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  renameSync(temp, path);
  pruneTrash(trash, `${basename(path)}-`, TRASH_KEEP_PER_FILE);
}

/** F4 ledger compaction: keeps the baseline and baseline-seen rows plus everything from the last `keepDays`. */
export function compactCorrespondenceLedger<T extends { kind?: unknown; at?: unknown }>(rows: T[], now: number, keepDays = 14): T[] {
  const cutoff = now - keepDays * 86_400_000;
  return rows.filter(row => row?.kind === 'baseline' || row?.kind === 'incoming_baseline_seen' ||
    typeof row?.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) >= cutoff);
}

/** Free text that looks like a credential (API tokens, long opaque strings, key=value). It is never persisted. */
export function looksLikeSecret(text: string): boolean {
  return /(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|\b[A-Za-z0-9_+/=-]{40,}\b|(?:key|token|secret|password|passwd|clave)\s*[:=]\s*\S{6,}/i.test(text);
}
