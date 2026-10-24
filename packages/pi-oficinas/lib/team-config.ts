import { readFileSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

export interface TeamSecretaryConfig {
  monitor?: boolean;
  avisos?: boolean;
  contexto?: boolean;
  correo?: boolean;
  correo_respaldo?: boolean;
  quiet_min?: number;
  parada_min?: number;
  reentrada_cooldown_min?: number;
  contexto_aviso?: number;
  contexto_ttl_min?: number;
  gracia_min?: number;
  correo_cada_min?: number;
  correo_tope_diario?: number;
  correo_tope_hora?: number;
  confirmacion_min?: number;
  correo_racha_fallo?: number;
  correo_lote_medios_min?: number;
  correo_silencio_humano_min?: number;
}
export interface TeamConfig {
  version: 2;
  lider: string;
  lider_key_env: string;
  office_key_prefix: string;
  base: string;
  lider_body: string;
  soul_prefix: string;
  souls?: Record<string,string>;
  secretaria?: TeamSecretaryConfig;
  oficinas: string[];
  distribucion: string;
  /** Optional local Pi runtime; when present it must be exactly <base>/runtime/node_modules/.bin/pi (existence is checked later by the canary, not here). */
  pi_bin?: string;
  /** Optional relaunch policy; absent means `fresco`. */
  relanzar_modo?: 'fresco'|'retomar';
  /** Opt-in only. The only accepted value is `.pi-agent` under each body. Absent: pi keeps ~/.pi/agent. */
  pi_coding_agent_dir?: string;
  /** Opt-in only. The only accepted value is `sessions` under each body. */
  pi_coding_session_dir?: string;
}
const validName = (s: unknown): s is string => typeof s === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(s);
const within = (root: string, child: string) => { const r=relative(root,child); return r!=='' && !r.startsWith('..') && !isAbsolute(r); };
function safePath(path:string, directory=false) {
  if(!isAbsolute(path) || resolve(path)!==path) throw new Error('Ruta de equipo no absoluta o traversal');
  let part=path;
  while(true) {
    try { if(lstatSync(part).isSymbolicLink()) throw new Error('Symlink en ruta de equipo'); }
    catch(e:any) { if(e.code!=='ENOENT') throw e; }
    const next=dirname(part); if(next===part) break; part=next;
  }
  if(directory && !statSync(path).isDirectory()) throw new Error('Directorio de equipo inexistente');
}
function uniqueObject(text:string):Record<string,unknown> {
  // JSON.parse drops duplicate keys; reject them before they can change authorization.
  const keys=new Set<string>();
  const top=/^\s*\{([\s\S]*)\}\s*$/.exec(text);
  if(!top) throw new Error('Config JSON inválida');
  // Parse each top-level member with a JSON token scanner, including nested arrays.
  const raw=top[1]; let i=0;
  while(i<raw.length) {
    while(/[\s,]/.test(raw[i]??'') && i<raw.length)i++;
    if(i>=raw.length)break;
    if(raw[i]!=='"') throw new Error('Config JSON inválida');
    const start=i++; while(i<raw.length) { if(raw[i]==='\\')i+=2;else if(raw[i++]==='"')break; }
    const key=JSON.parse(raw.slice(start,i));
    if(keys.has(key))throw new Error('Clave duplicada en config'); keys.add(key);
    while(/\s/.test(raw[i]??'')&&i<raw.length)i++;
    if(raw[i++]!==':')throw new Error('Config JSON inválida');
    let depth=0,quoted=false;
    const valueStart=i;
    for(;i<raw.length;i++) {const ch=raw[i];if(quoted){if(ch==='\\')i++;else if(ch==='"')quoted=false;}
      else if(ch==='"')quoted=true;else if(ch==='['||ch==='{')depth++;else if(ch===']'||ch==='}')depth--;
      else if(ch===','&&depth===0)break;}
    if(key==='souls'||key==='secretaria')uniqueObject(raw.slice(valueStart,i));
  }
  return JSON.parse(text);
}
const FIELDS=['version','lider','lider_key_env','office_key_prefix','base','lider_body','soul_prefix','oficinas','distribucion'];
const OPTIONAL_FIELDS=['souls','secretaria','pi_bin','relanzar_modo','pi_coding_agent_dir','pi_coding_session_dir'];
const validSoul=(path:unknown):path is string=>typeof path==='string' &&
  /^50 Agents\/[A-Za-z0-9 -]+(?:\/[A-Za-z0-9 -]+)*\/SOUL\.md$/.test(path);
/** In plain Pi, the process need not export .env. Read ONLY the local non-secret
 * config pointer; reject malformed/duplicate entries rather than choosing a team. */
function localConfigFile(): string | undefined {
  const cwd=process.cwd(); safePath(cwd,true);
  const dotEnv=join(cwd,'.env'); safePath(dotEnv);
  let info;
  try { info=statSync(dotEnv); }
  catch(e:any) { if(e.code==='ENOENT') return undefined; throw e; }
  if(!info.isFile() || info.uid!==process.getuid?.() || (info.mode & 0o077))
    throw new Error('Env local inseguro o inexistente; config explícita requerida');
  const lines=readFileSync(dotEnv,'utf8').split(/\r?\n/);
  const matches=lines.filter(line=>/^\s*PI_OFICINAS_EQUIPO\s*=/.test(line));
  if(matches.length===0) return undefined;
  if(matches.length!==1) throw new Error('PI_OFICINAS_EQUIPO local ausente o duplicado');
  const match=/^PI_OFICINAS_EQUIPO=(\/[^\s"'`\\]*)$/.exec(matches[0]);
  if(!match) throw new Error('PI_OFICINAS_EQUIPO local inválido');
  return match[1];
}
/** Explicit process configuration or owned local body pointer; no legacy fallback. */
export function teamConfig(): TeamConfig {
  const local = process.env.PI_OFICINAS_EQUIPO ? undefined : localConfigFile();

  const file = process.env.PI_OFICINAS_EQUIPO || local;
  if (!file) throw new Error('Explicit PI_OFICINAS_EQUIPO required');
  safePath(file);
  const fileStat=statSync(file);
  if(!fileStat.isFile() || fileStat.uid!==process.getuid?.() || (fileStat.mode & 0o022))
    throw new Error('Config equipo no regular, ajena al usuario o escribible por grupo/otros');
  const c = uniqueObject(readFileSync(file,'utf8')) as unknown as TeamConfig;
  if(Object.keys(c).length<FIELDS.length || FIELDS.some(k=>!(k in c)) ||
     Object.keys(c).some(k=>![...FIELDS,...OPTIONAL_FIELDS].includes(k)) ||
     (c.souls!==undefined && (c.souls===null || typeof c.souls!=='object' || Array.isArray(c.souls) ||
       Object.entries(c.souls).some(([agent,soul])=>![c.lider,...c.oficinas].includes(agent) || !validSoul(soul)))) ||
     (c.secretaria!==undefined && (c.secretaria===null || typeof c.secretaria!=='object' || Array.isArray(c.secretaria) ||
       Object.entries(c.secretaria).some(([key,value])=>{
         if(['monitor','avisos','contexto','correo','correo_respaldo'].includes(key))return typeof value!=='boolean';
         const ranges:Record<string,[number,number]>={quiet_min:[1,1440],parada_min:[1,1440],pegada_min:[1,1440],
           reentrada_cooldown_min:[60,1440],contexto_aviso:[1,99],
           contexto_ttl_min:[1,1440],gracia_min:[0,60],correo_cada_min:[1,1440],correo_tope_diario:[1,1000],
           correo_tope_hora:[1,100],confirmacion_min:[1,1440],correo_racha_fallo:[1,1000],
           correo_lote_medios_min:[1,1440],correo_silencio_humano_min:[0,1440]};
         const range=ranges[key];return !range||!Number.isInteger(value)||Number(value)<range[0]||Number(value)>range[1];
       }))) ||
     !Number.isInteger(c.version) || c.version!==2 || !validName(c.lider) || !Array.isArray(c.oficinas) || !c.oficinas.length || c.oficinas.length>20 ||
     c.oficinas.some(n=>!validName(n)||n===c.lider) || new Set(c.oficinas).size!==c.oficinas.length ||
     typeof c.lider_key_env!=='string' || !/^[A-Z][A-Z0-9_]*$/.test(c.lider_key_env) ||
     typeof c.office_key_prefix!=='string' || !/^[A-Z][A-Z0-9_]*_$/.test(c.office_key_prefix) ||
     c.oficinas.some(n => c.lider_key_env === c.office_key_prefix + n.toUpperCase().replace(/-/g, '_')) ||
     typeof c.base!=='string' || !isAbsolute(c.base) || resolve(c.base)!==c.base ||
     typeof c.lider_body!=='string' || !isAbsolute(c.lider_body) || resolve(c.lider_body)!==c.lider_body ||
     !within(c.base,c.lider_body) || typeof c.soul_prefix!=='string' || !/^(?:50 Agents\/[A-Za-z0-9 -]+)(?:\/[A-Za-z0-9 -]+)*$/.test(c.soul_prefix) ||
     typeof c.distribucion!=='string' || !/^[A-Za-z0-9_-]+\.json$/.test(c.distribucion) ||
     (c.pi_bin!==undefined && (typeof c.pi_bin!=='string' || c.pi_bin!==join(c.base,'runtime','node_modules','.bin','pi'))) ||
     (c.relanzar_modo!==undefined && c.relanzar_modo!=='fresco' && c.relanzar_modo!=='retomar') ||
     (c.pi_coding_agent_dir!==undefined && c.pi_coding_agent_dir!=='.pi-agent') ||
     (c.pi_coding_session_dir!==undefined && c.pi_coding_session_dir!=='sessions'))
    throw new Error('Config equipo inválida; no seleccionar identidad');
  safePath(c.base,true);safePath(c.lider_body,true);
  for(const p of [join(c.base,c.distribucion),join(c.base,'registro.json'),...c.oficinas.map(n=>join(c.base,n))])safePath(p);
  if(local && (file!==join(c.base,'equipo.json') ||
     !(process.cwd()===c.lider_body || c.oficinas.some(n=>process.cwd()===join(c.base,n)))))
    throw new Error('Config local fuera del equipo o cuerpo ajeno');
  return c;
}
export function secretaryConfig(c:TeamConfig) {
  const raw=c.secretaria??{};
  return {monitor:raw.monitor??true,avisos:raw.avisos??false,contexto:raw.contexto??false,correo:raw.correo??false,
    quiet_min:raw.quiet_min??30,parada_min:raw.parada_min??10,pegada_min:raw.pegada_min??20,
     reentrada_cooldown_min:raw.reentrada_cooldown_min??60,contexto_aviso:raw.contexto_aviso??60,
    contexto_ttl_min:raw.contexto_ttl_min??5,gracia_min:raw.gracia_min??5,correo_cada_min:raw.correo_cada_min??2,
    correo_tope_diario:raw.correo_tope_diario??20,correo_tope_hora:raw.correo_tope_hora??5,confirmacion_min:raw.confirmacion_min??15,
    correo_racha_fallo:raw.correo_racha_fallo??5,
    correo_respaldo:raw.correo_respaldo??true,correo_lote_medios_min:raw.correo_lote_medios_min??30,
    correo_silencio_humano_min:raw.correo_silencio_humano_min??10};
}
export function officeSoulPath(c:TeamConfig, office:string):string {
  if(!c.oficinas.includes(office)) throw new Error('Oficina ajena a equipo');
  return c.souls?.[office] ?? `${c.soul_prefix}/${office}/Vigente/SOUL.md`;
}
export function officeKeyEnv(c:TeamConfig, office:string):string {
  if(!c.oficinas.includes(office)) throw new Error('Oficina ajena a equipo');
  return c.office_key_prefix+office.toUpperCase().replace(/-/g,'_');
}
export function teamRole(c:TeamConfig,cwd:string,marked:boolean,agent?:string):'leader'|'office'|'none' {
  if(marked && agent && c.oficinas.includes(agent) && resolve(cwd)===join(c.base,agent)) return 'office';
  if(!marked && resolve(cwd)===c.lider_body) return 'leader';
  return 'none';
}
