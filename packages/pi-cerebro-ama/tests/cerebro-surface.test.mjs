import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEREBRO_CORE, readCerebroMode, cerebroExposure, withCerebroSurface } from '../lib/cerebro-surface.ts';
import { loadHerramientasConfig, resolverInicial } from '../lib/herramientas-activar.ts';
import { attachHerramientas } from '../extensions/herramientas-activar.ts';
const raw = { base: '*', grupos: { web: { linea: 'web', tools: ['web_search'] } } };
const universe = ['read', 'bash', 'codemode', ...CEREBRO_CORE, 'cb_task_activity', 'cb_checkpoint_agent_save', 'web_search'];
function temp() { const d = mkdtempSync(join(tmpdir(), 'surface-')); mkdirSync(join(d, '.pi')); return d; }
function resolved() { return resolverInicial(loadHerramientasConfig(JSON.stringify(raw)), universe); }
test('opt-in estricto: ausente/invalid/traditional no cambia default', () => {
 const d=temp(); try {
  writeFileSync(join(d,'.pi/herramientas.json'), JSON.stringify(raw));
  assert.equal(readCerebroMode(d), 'traditional');
  for (const data of ['no json','{}','[]','{"mode":"traditional"}','{"mode":"code","extra":true}']) {
   writeFileSync(join(d,'.pi/cerebro-surface.json'),data); assert.equal(readCerebroMode(d),'traditional');
  }
  writeFileSync(join(d,'.pi/cerebro-surface.json'),'{"mode":"ama"}'); assert.equal(readCerebroMode(d),'ama');
  writeFileSync(join(d,'.pi/cerebro-surface.json'),'{"mode":"code"}'); assert.equal(readCerebroMode(d),'ama');
  writeFileSync(join(d,'.pi/herramientas.json'),'{}'); assert.equal(readCerebroMode(d),'traditional');
 } finally {rmSync(d,{recursive:true});}
});
test('traditional preserva referencia/config y exposure direct', () => {
 const c=resolved(); assert.equal(withCerebroSurface(c,universe,'traditional'),c);
 for(const name of universe) assert.equal(cerebroExposure('traditional',name),'direct');
});
test('8 core direct; resto codemode (no hidden ni unregister)', () => {
 for(const n of CEREBRO_CORE) assert.equal(cerebroExposure('code',n),'direct');
 assert.equal(cerebroExposure('code','cb_task_activity'),'codemode');
 assert.equal(cerebroExposure('code','read'),'direct');
});
test('base code preserva no-cb, grupos existentes y núcleo; opcionales en catálogo', () => {
 const c=withCerebroSurface(resolved(),universe,'code');
 assert.deepEqual(c.base,['read','bash',...CEREBRO_CORE,'codemode']);
 assert.deepEqual(c.grupos.web,raw.grupos.web);
 assert.deepEqual(c.grupos.cerebro.tools,['cb_task_activity','cb_checkpoint_agent_save']);
 assert(!c.base.includes('cb_task_activity'));
});
test('sin codemode/no config no se reduce set',()=>{
 const c=resolved(); assert.equal(withCerebroSurface(c,universe.filter(n=>n!=='codemode'),'code'),c);
 assert.equal(withCerebroSurface(null,universe,'code'),null);
});
test('respeta universo/allowlist: no agrega núcleo ausente',()=>{
 const u=['read','codemode','cb_task_activity'];
 const c=withCerebroSurface({base:['read'],grupos:{}},u,'code');
 assert.deepEqual(c.base,['read','codemode']); assert.deepEqual(c.grupos.cerebro.tools,['cb_task_activity']);
});
test('grupo cerebro previo no pierde herramientas no-cb',()=>{
 const c=withCerebroSurface({base:['read'],grupos:{cerebro:{linea:'preexistente',tools:['extra']}}},universe,'code');
 assert(c.grupos.cerebro.tools.includes('extra'));
});
test('AMA canónico y alias code: idéntica exposición y activación de catálogo',()=>{
 const c=resolved(); assert.deepEqual(withCerebroSurface(c,universe,'ama'),withCerebroSurface(c,universe,'code'));
 for(const name of universe) assert.equal(cerebroExposure('ama',name),cerebroExposure('code',name));
 assert.equal(cerebroExposure('ama','cb_task_activity'),'codemode');
});
for(const mode of ['ama','code']) {
test(`integración ${mode}: startup, activation explícita, reconcile no pierde extras ni reordena`,async()=>{
 const d=temp(); try {
  writeFileSync(join(d,'.pi/herramientas.json'),JSON.stringify(raw));
  const registered = universe.map(name=>({name,exposure:name==='codemode'||name==='cb_task_activity'||name==='cb_checkpoint_agent_save'?'codemode':'direct'}));
  registered.push({name:'cb_prohibida',exposure:'hidden'},{name:'foreign',exposure:'codemode'});
  const events={}, tools={}; let active=[]; let updates=0;
  const pi={getAllTools:()=>registered,getActiveTools:()=>active,setActiveTools:(s)=>{active=s;updates++;},registerTool:(t)=>{tools[t.name]=t;if(!registered.find(x=>x.name===t.name))registered.push({name:t.name});},on:(e,h)=>events[e]=h};
  attachHerramientas(pi,mode); const ctx={cwd:d}; events.session_start({},ctx);
  assert(active.includes('codemode')); assert(active.includes('cb_whoami')); assert(!active.includes('cb_task_activity'));
  assert(!active.includes('foreign')); assert(!active.includes('cb_prohibida'));
  await tools.herramientas_activar.execute('t',{nombres:['cb_task_activity','cb_prohibida']},undefined,undefined,ctx);
  assert(active.includes('cb_task_activity')); assert(!active.includes('cb_prohibida'));
  active.reverse(); const before=[...active]; const count=updates; events.before_agent_start({},ctx);
  assert.deepEqual(active,before); assert.equal(updates,count);
 } finally {rmSync(d,{recursive:true});}
});
}
test('integración tradicional conserva cb direct activas y grupos a demanda',()=>{
 const d=temp(); try {
  writeFileSync(join(d,'.pi/herramientas.json'),JSON.stringify(raw)); let active=[];const events={};
  const registered=universe.filter(n=>n!=='codemode').map(name=>({name,exposure:'direct'}));
  const pi={getAllTools:()=>registered,getActiveTools:()=>active,setActiveTools:s=>active=s,registerTool:t=>registered.push({name:t.name}),on:(e,h)=>events[e]=h};
  attachHerramientas(pi,'traditional'); events.session_start({},{cwd:d});
  assert(active.includes('cb_task_activity'));assert(!active.includes('web_search'));
 }finally{rmSync(d,{recursive:true});}
});
