import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CEREBRO_CORE,CEREBRO_CORE_LIDER,CEREBRO_LIDER_ADMIN,readCerebroSurface,cerebroExposure,withCerebroSurface} from '../lib/cerebro-surface.ts';
import {attachHerramientas} from '../extensions/herramientas-activar.ts';
const raw={base:['read'],grupos:{web:{linea:'web',tools:['web_search']}}};
const universe=['read','codemode',...CEREBRO_CORE_LIDER,...CEREBRO_LIDER_ADMIN,'cb_checkpoint_agent_save','web_search'];
test('R6 omitted perfil defaults subagente; valid explicit profiles and legacy code',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'profile-'));mkdirSync(join(cwd,'.pi'));
 try{writeFileSync(join(cwd,'.pi/herramientas.json'),JSON.stringify(raw));
  for(const mode of ['ama','code'])for(const perfil of [undefined,'subagente','lider']){
   writeFileSync(join(cwd,'.pi/cerebro-surface.json'),JSON.stringify({mode,perfil}));
   assert.deepEqual(readCerebroSurface(cwd),{mode:'ama',perfil:perfil??'subagente'});
  }
  for(const data of [{mode:'ama',perfil:'admin'},{mode:'ama',perfil:null},{mode:'ama',perfil:'lider',extra:true},{mode:'ama',perfil:[]},{perfil:'lider'}]){
   writeFileSync(join(cwd,'.pi/cerebro-surface.json'),JSON.stringify(data));assert.deepEqual(readCerebroSurface(cwd),{mode:'traditional',perfil:'subagente'});
  }
 }finally{rmSync(cwd,{recursive:true});}
});
test('R6 leader direct core is exactly eight plus six, unique and capped at fourteen',()=>{
 assert.equal(CEREBRO_CORE.length,8);assert.equal(CEREBRO_CORE_LIDER.length,14);assert.equal(new Set(CEREBRO_CORE_LIDER).size,14);
 for(const n of CEREBRO_CORE_LIDER)assert.equal(cerebroExposure('ama',n,'lider'),'direct');
 for(const n of CEREBRO_CORE_LIDER.filter(n=>!CEREBRO_CORE.includes(n)))assert.equal(cerebroExposure('ama',n),'codemode');
 assert.equal(cerebroExposure('ama','cb_checkpoint_agent_save','lider'),'codemode');
});
test('R6 leader/admin-only optional routes unavailable to subagent profile; never grants server permissions',()=>{
 for(const n of CEREBRO_LIDER_ADMIN){assert.equal(cerebroExposure('ama',n,'subagente'),'hidden');assert.equal(cerebroExposure('ama',n,'lider'),'codemode');assert.equal(cerebroExposure('traditional',n,'subagente'),'direct');}
 const sub=withCerebroSurface(raw,universe,'ama');assert(!sub.base.some(n=>CEREBRO_LIDER_ADMIN.includes(n)));assert(!sub.grupos.cerebro.tools.some(n=>CEREBRO_LIDER_ADMIN.includes(n)));
 const leader=withCerebroSurface(raw,universe,'ama','lider');assert(CEREBRO_LIDER_ADMIN.every(n=>leader.grupos.cerebro.tools.includes(n)));
});
test('R6 explicit leader profile respects absent registered/allowed tools',()=>{
 const c=withCerebroSurface(raw,['read','codemode','cb_whoami','cb_task_activity'],'ama','lider');assert.deepEqual(c.base,['read','cb_whoami','cb_task_activity','codemode']);assert(!c.base.includes('cb_task_create'));
});
test('R6 profiles preserve non-Cerebro groups and missing-codemode/traditional parity',()=>{
 for(const perfil of ['lider','subagente']){
  const c=withCerebroSurface(raw,universe,'ama',perfil);assert.deepEqual(c.grupos.web,raw.grupos.web);assert(c.base.includes('read'));
  assert.equal(withCerebroSurface(raw,universe.filter(n=>n!='codemode'),'ama',perfil),raw);assert.equal(withCerebroSurface(raw,universe,'traditional',perfil),raw);
 }
});
for(const perfil of ['lider','subagente'])test(`R6 activator ${perfil} core/exposure, callability and stable reconciliation`,()=>{
 const cwd=mkdtempSync(join(tmpdir(),'profile-'));mkdirSync(join(cwd,'.pi'));writeFileSync(join(cwd,'.pi/herramientas.json'),JSON.stringify(raw));
 try{
  const registered=universe.map(name=>({name,exposure:cerebroExposure('ama',name,perfil)}));let active=[];let updates=0;const handlers={};
  const pi={getAllTools:()=>registered,getActiveTools:()=>active,setActiveTools:n=>{active=n;updates++;},registerTool:t=>registered.push({name:t.name}),on:(e,h)=>handlers[e]=h};
  attachHerramientas(pi,'ama',perfil);handlers.session_start({},{cwd});
  assert.deepEqual(active.filter(n=>n.startsWith('cb_')).sort(),[...(perfil==='lider'?CEREBRO_CORE_LIDER:CEREBRO_CORE)].sort());
  active.reverse();const previous=[...active];const before=updates;handlers.before_agent_start({},{cwd});assert.deepEqual(active,previous);assert.equal(updates,before);
 }finally{rmSync(cwd,{recursive:true});}
});
