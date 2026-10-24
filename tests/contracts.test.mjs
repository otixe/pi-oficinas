import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import * as order from '../packages/pi-cache-estable/lib/tools-order.ts';
import * as tools from '../packages/pi-herramientas/lib/herramientas-activar.ts';
import * as renewal from '../packages/pi-renovacion/lib/context70.ts';
import * as relaunch from '../packages/pi-renovacion/lib/context-relaunch.ts';
import * as identity from '../packages/pi-oficinas/lib/cerebro-identity.ts';
import {teamConfig} from '../packages/pi-oficinas/lib/team-config.ts';
import {resolveIdentity} from '../packages/pi-plan-gate/lib/backend.ts';

const work=process.env.PI_TEST_WORK || join(homedir(),'work');
const fixture=mkdtempSync(join(work,'pi-public-contracts-'));
const base=join(fixture,'team');mkdirSync(base);mkdirSync(join(base,'coordinator'));mkdirSync(join(base,'worker'));
const config={version:2,lider:'coordinator',lider_key_env:'TEAM_COORDINATOR_KEY',office_key_prefix:'TEAM_OFFICE_KEY_',base,lider_body:join(base,'coordinator'),soul_prefix:'50 Agents/Example/Equipo',oficinas:['worker'],distribucion:'distribucion.json'};
const file=join(base,'equipo.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});
process.env.PI_OFICINAS_EQUIPO=file;
const registered=['read','bash','edit','write','outside','herramientas_activar'];
const catalog=tools.parseHerramientasConfig({base:['read','bash'],grupos:{editing:{linea:'Edit tools',tools:['edit','write']}}});

test('all five package manifests: host peers only, explicit extension entry points and MIT',()=>{
 for(const name of ['pi-oficinas','pi-cache-estable','pi-renovacion','pi-plan-gate','pi-herramientas']){
  const p=JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`,import.meta.url)));
  assert.equal(p.name,`@otixe/${name}`);assert.equal(p.version,'0.1.0');assert.equal(p.license,'MIT');assert.ok(p.keywords.includes('pi-package'));assert.ok(p.keywords.length>=4);assert.ok(p.pi.image.startsWith('https://raw.githubusercontent.com/otixe/pi-oficinas/'));
  assert.equal(p.dependencies,undefined);assert.equal(Object.keys(p.peerDependencies).length,5);assert.ok(Object.values(p.peerDependencies).every(v=>v==='*'));assert.ok(p.pi.extensions.length>0);
 }
});
test('order policy invalid/absent is transparent',()=>{assert.equal(order.parseToolsOrder({version:2}),null);assert.equal(order.readToolsOrder(fixture),null)});
test('order never expands membership, ranks wildcard matches and sorts unlisted',()=>{
 const p=order.parseToolsOrder({version:1,priority:['read','plan_*'],unlisted:'alphabetical'});
 assert.deepEqual(order.canonicalToolNames(['write','plan_check','read','bash','read'],p),['read','plan_check','bash','write']);
 assert.equal(order.sameToolMembership(['write','read','read'],['read','write']),true);
});
test('catalog projection includes base and registered requested tools only',()=>{assert.deepEqual(tools.projectActiveSet(catalog,registered,['edit','outside','invented']),['read','bash','edit','herramientas_activar'])});
test('missing catalog, missing registered base, invalid config stay inert',()=>{
 assert.equal(tools.projectActiveSet(null,registered,['edit']),null);assert.equal(tools.projectActiveSet(catalog,['edit'],['edit']),null);
 assert.equal(tools.parseHerramientasConfig({base:['read'],grupos:{},extra:true}),null);
});
test('tool requests reject unknown group and never accept out-of-catalog tool',()=>{
 assert.equal(tools.classifyRequest(catalog,registered,'unknown').ok,false);
 const r=tools.classifyRequest(catalog,registered,undefined,['outside']);assert.deepEqual(r.accepted,[]);assert.equal(r.ok,false);
});
test('dynamic base universe is an intersection, not new permissions',()=>{
 const c=tools.parseHerramientasConfig({base:'*',grupos:{editing:{linea:'Edit',tools:['edit','invented']}}});
 const concrete=tools.resolverInicial(c,['read','edit','herramientas_activar']);assert.deepEqual(concrete.base,['read']);assert.deepEqual(concrete.grupos.editing.tools,['edit']);
});
test('unknown/high context defers new task, never cancels working task',()=>{
 for(const percent of [null,70,100,NaN,-1,101])assert.equal(renewal.shouldDeferNewTask({percent},'todo'),true);
 assert.equal(renewal.shouldDeferNewTask({percent:69},'todo'),false);assert.equal(renewal.shouldDeferNewTask(null,'in_progress'),false);
});
test('context snapshot cannot follow a stale/different session',()=>{
 const snapshot={tokens:70,contextWindow:100,percent:70,sessionId:'session-one',sessionFile:join(fixture,'one.jsonl'),observedAt:Date.now()};
 renewal.writeContextSnapshot(base,snapshot,snapshot.sessionFile);
 assert.deepEqual(renewal.readContextSnapshot(base,snapshot.sessionFile),snapshot);assert.equal(renewal.readContextSnapshot(base,join(fixture,'two.jsonl')),null);
 assert.equal(renewal.readContextSnapshot(base,snapshot.sessionFile,Date.now(),'other'),null);
});
test('renewal notices have bounded grammar and cannot inject shell syntax or foreign office',()=>{
 assert.deepEqual(relaunch.parseContextNotice('worker al 80% de contexto: relanzar antes de task-one',['worker']),{office:'worker',percent:80,taskId:'task-one'});
 assert.equal(relaunch.parseContextNotice('worker al 80% de contexto: relanzar antes de task;echo x',['worker']),null);
 assert.equal(relaunch.parseContextNotice('other al 80% de contexto: relanzar antes de task-one',['worker']),null);
});
test('generic explicit team config loads; duplicates fail closed',()=>{
 assert.equal(teamConfig().lider,'coordinator');writeFileSync(file,JSON.stringify(config).replace('"version":2','"version":2,"version":2'));
 assert.throws(()=>teamConfig(),/duplicada/);writeFileSync(file,JSON.stringify(config));
});
test('team role credential variable collision is rejected before identity resolution',()=>{
 writeFileSync(file,JSON.stringify({...config,lider_key_env:'TEAM_OFFICE_KEY_WORKER'}));
 assert.throws(()=>teamConfig(),/inválida/);writeFileSync(file,JSON.stringify(config));
});
test('safe prompt shape takes a thunk and unknown reading stays closed',()=>{
 assert.equal(identity.safeSubagentShapeSignal(()=> 'Independent office prompt'),false);
 assert.equal(identity.safeSubagentShapeSignal(()=> '<active_agent name="worker"/>'),true);
 assert.equal(identity.safeSubagentShapeSignal(()=> {throw Error('unreadable')}),true);
});
test('office identity uses its configured key, never inherited leader or sibling',()=>{
 const env={BODY_ROLE:'office',AGENT_NAME:'worker',AGENT_KEY_ENV:'TEAM_OFFICE_KEY_WORKER',AGENT_ENABLED:'1'};
 const penv={TEAM_COORDINATOR_KEY:'fixture-leader',TEAM_OFFICE_KEY_OTHER:'fixture-sibling',TEAM_OFFICE_KEY_WORKER:'fixture-own'};
 assert.equal(identity.resolveIdentityFrom('worker',env,penv,true).key,'fixture-own');
 assert.equal(identity.resolveIdentityFrom('other',env,penv,true).key,'');
 assert.equal(identity.resolveIdentityFrom(null,env,{TEAM_COORDINATOR_KEY:'fixture-leader'},false).key,'');
 assert.equal(identity.resolveIdentityFrom(null,{...env,AGENT_ENABLED:'0'},penv,false).key,'');
});
test('ambiguous/malformed delegate shapes cannot become principal',()=>{
 const parsed=identity.resolveAgentNameFromPrompt('<active_agent name="worker"/><active_agent name="other"/>');
 assert.equal(parsed,null);assert.equal(identity.resolveIdentityFrom(null,{}, {TEAM_COORDINATOR_KEY:'fixture-leader'},true).key,'');
});
test('plan principal fails closed on unreadable/empty/delegate prompt',()=>{
 process.env.PLAN_GATE_AGENT='coordinator';process.env.PLAN_GATE_KEY='fixture-only';
 for(const ctx of [{cwd:fixture,getSystemPrompt(){throw Error('unreadable')}},{cwd:fixture,getSystemPrompt:()=>''},{cwd:fixture,getSystemPrompt:()=>'<agent_instructions>'}])assert.equal(resolveIdentity(ctx).isSubagent,true);
 assert.equal(resolveIdentity({cwd:fixture,getSystemPrompt:()=> 'Independent configured principal'}).isSubagent,false);
});

// Only this test's loopback server is contacted. No credentials/account files are inherited.
let response={status:200,data:{agent:'coordinator'}};
const server=createServer((req,res)=>{res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(response.data));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));after(()=>new Promise(r=>server.close(r)));
process.env.PLAN_GATE_BASE_URL=`http://127.0.0.1:${server.address().port}`;
const runtime=process.env.PI_TEST_RUNTIME;if(!runtime)throw Error('Set PI_TEST_RUNTIME to host node_modules; never install duplicate host peers');
const require=createRequire(join(resolve(runtime),'package.json'));
const jiti=require('jiti').createJiti(import.meta.url,{moduleCache:false,alias:{typebox:require.resolve('typebox')}});
const plan=await jiti.import(new URL('../packages/pi-plan-gate/extensions/plan-gate.ts',import.meta.url).pathname);
const ctx={cwd:fixture,getSystemPrompt:()=> 'Independent configured principal'};
test('plan enters only after durable ACK with matching owner',async()=>{plan.__test__.reset();response={status:200,data:{agent:'coordinator'}};assert.equal((await plan.planEnter(ctx)).phase,'planning')});
test('plan failed ACK/wrong attribution do not advance memory',async()=>{
 plan.__test__.reset();response={status:503,data:{}};await assert.rejects(()=>plan.planEnter(ctx));assert.equal(plan.loadPlanState().phase,'idle');
 response={status:200,data:{agent:'other'}};await assert.rejects(()=>plan.planEnter(ctx));assert.equal(plan.loadPlanState().phase,'idle');
});
test('plan restore 404 is visible failure, not absent-state success',async()=>{response={status:404,data:{}};assert.match(await plan.restore(ctx),/no se pudo/);assert.equal(plan.loadPlanState().phase,'idle')});
test('plan blocks writes/delegation and accepts only configured human review',async()=>{
 response={status:200,data:{agent:'coordinator'}};await plan.planEnter(ctx);
 assert.equal(plan.planGateDecision(fixture,'edit',{},fixture).block,true);assert.equal(plan.planGateDecision(fixture,'subagent',{subagent_type:'worker'},fixture).block,true);
 assert.equal(plan.planVerdict('done',[{kind:'review',from_status:'submitted',to_status:'done',body:'pass: reviewed',agent:'other'}]),'pending');
 assert.equal(plan.planVerdict('done',[{kind:'review',from_status:'submitted',to_status:'done',body:'pass: reviewed',agent:'human'}]),'approved');
});
