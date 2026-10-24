"""Open a real example office via packaged CLI, real Pi and isolated named Herdr.
Model/backend tools are TEST DOUBLES. This proves opening protocol, not production authorization.
Must be invoked by an agent already in Herdr. Requires an existing smoke HOME and --herdr/--pi.
All pane controls explicitly select this test session; cleanup stops only that named test session.
"""
import argparse,json,os,pwd,shlex,subprocess,time,uuid
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--pi',required=True);parser.add_argument('--herdr',required=True);args=parser.parse_args()
assert os.environ.get('HERDR_ENV')=='1','Caller must already be Herdr-managed'
root=Path(__file__).resolve().parents[1];home=Path.home()
work_base=(Path(pwd.getpwuid(os.getuid()).pw_dir)/'work').resolve()
assert home.resolve()!=work_base and home.resolve().is_relative_to(work_base),'HOME must be an isolated child directory of the OS user work directory'
cli=home/'smoke/installed/pi-oficinas/package/bin/oficina'
assert cli.is_file() and json.loads((home/'smoke/results.json').read_text()).get('extractedPrint') is True,'Run the clean-HOME smoke first; never use a live HOME'
work=home/'office-opening';work.mkdir();temp=home/'tmp';temp.mkdir(mode=0o700,exist_ok=True)
team=work/'team';leader=team/'coordinator';body=team/'worker'
for folder in [leader/'.pi/agents',body/'.pi/agents',body/'state',team/'runtime/node_modules/.bin',home/'.local/bin']:folder.mkdir(parents=True,exist_ok=True)
session='pi-public-'+uuid.uuid4().hex[:10]
pi=str(Path(args.pi).absolute());herdr=str(Path(args.herdr).absolute());shim=home/'.local/bin/herdr'
shim.write_text('#!/bin/sh\nexec '+shlex.quote(herdr)+' --session '+shlex.quote(session)+' "$@"\n');shim.chmod(0o755)
pin=team/'runtime/node_modules/.bin/pi';pin.write_text('#!/bin/sh\nexec '+shlex.quote(pi)+' "$@"\n');pin.chmod(0o755)
config={'version':2,'lider':'coordinator','lider_key_env':'TEAM_COORDINATOR_KEY','office_key_prefix':'TEAM_OFFICE_KEY_','base':str(team),'lider_body':str(leader),'soul_prefix':'50 Agents/Example/Equipo','oficinas':['worker'],'distribucion':'distribucion.json','pi_bin':str(pin),'secretaria':{'monitor':False,'avisos':False,'contexto':False,'correo':False}}
file=team/'equipo.json';file.write_text(json.dumps(config));file.chmod(0o600)
(team/'distribucion.json').write_text((root/'packages/pi-oficinas/examples/distribucion.json').read_text())
profile=(root/'packages/pi-oficinas/examples/worker.md').read_text().replace('enabled: false','enabled: true').replace('model: example/model','model: offline-smoke/fixture')
for f in [leader/'.pi/agents/worker.md',body/'.pi/agents/worker.md']:f.write_text(profile)
(body/'.pi/oficina-body').write_text('pi-oficinas-v1\n')
(body/'.pi/APPEND_SYSTEM.md').write_text('<office_agent name="worker"/>\nRead the neutral example SOUL. This is an isolated opening test, not production work.\n')
(body/'SOUL.md').write_text((root/'packages/pi-oficinas/examples/SOUL.md').read_text())
server_env={'HOME':str(home),'TMPDIR':str(temp),'PYTHONDONTWRITEBYTECODE':'1','PATH':f'{home}/.local/bin:{Path(pi).parent}:/usr/bin:/bin','LANG':'C.UTF-8','SHELL':'/bin/bash','PI_OFFICE_FIXTURE':'1','PI_SMOKE_KEY':'offline-fixture-not-a-real-credential','PI_OFICINAS_EQUIPO':str(file),'HERDR_CONFIG_PATH':str(work/'herdr.toml'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_RUNTIME_DIR':str(home/'.run')}
(work/'herdr.toml').write_text('[terminal]\ndefault_shell = "/bin/bash"\n')
model_server=subprocess.Popen(['python3',str(root/'tests/fixture-server.py'),'--work',str(work)],env=server_env,stdout=subprocess.DEVNULL,stderr=(work/'model-server.stderr').open('w'))
herdr_server=None

def command(name,argv,where=leader,timeout=90):
 r=subprocess.run(argv,cwd=where,env=server_env,capture_output=True,text=True,timeout=timeout)
 (work/(name+'.stdout')).write_text(r.stdout);(work/(name+'.stderr')).write_text(r.stderr);(work/(name+'.exit')).write_text(str(r.returncode)+'\n')
 if r.returncode:raise RuntimeError(f'{name} exited {r.returncode}; inspect {work}')
 return r
try:
 for _ in range(100):
  if (work/'endpoint.txt').exists():break
  time.sleep(.05)
 endpoint=(work/'endpoint.txt').read_text();server_env['PI_SMOKE_ENDPOINT']=endpoint+'/v1';server_env['CEREBRO_BASE']=endpoint
 (body/'.env').write_text(f'PI_OFICINAS_EQUIPO={file}\nAGENT_NAME=worker\nAGENT_KEY_ENV=TEAM_OFFICE_KEY_WORKER\nBODY_ROLE=office\nAGENT_ENABLED=1\nSOUL_PATH=50 Agents/Example/Equipo/worker/Vigente/SOUL.md\nTEAM_OFFICE_KEY_WORKER=offline-worker-fixture-only\nCEREBRO_BASE={endpoint}\nCEREBRO_AUTH_HEADER=X-API-Key\n');(body/'.env').chmod(0o600)
 for name in ['mock-provider','mock-cerebro']:command('install-'+name,[pi,'install',str(root/f'tests/{name}.ts')])
 command('install-pi-integration',[herdr,'integration','install','pi'])
 # New HOME + unique session + explicit selection: never the caller's live socket/session.
 herdr_server=subprocess.Popen([herdr,'--session',session,'server'],cwd=leader,env=server_env,stdout=(work/'herdr-server.stdout').open('w'),stderr=(work/'herdr-server.stderr').open('w'),start_new_session=True)
 for _ in range(120):
  r=subprocess.run([str(shim),'pane','list'],env=server_env,capture_output=True,text=True)
  if r.returncode==0:break
  if herdr_server.poll() is not None:raise RuntimeError('Isolated headless server stopped')
  time.sleep(.1)
 rows=json.loads(r.stdout)['result']['panes']
 if not rows:
  command('workspace-create',[str(shim),'workspace','create','--cwd',str(leader),'--label','Isolated example','--no-focus'])
  rows=json.loads(command('initial-pane-list',[str(shim),'pane','list']).stdout)['result']['panes']
 assert len(rows)==1,rows
 pane=rows[0]['pane_id'];server_env['HERDR_PANE_ID']=pane
 (work/'isolation.json').write_text(json.dumps({'session':session,'home':str(home),'leaderPane':pane,'serverPid':herdr_server.pid,'fixtureOnly':True},indent=2))
 cli=home/'smoke/installed/pi-oficinas/package/bin/oficina'
 command('office-help',['python3',str(cli),'--equipo',str(file),'--help'])
 result=command('office-open',['python3',str(cli),'--equipo',str(file),'abrir','worker'],timeout=200)
 assert 'ABIERTA worker' in result.stdout,result.stdout
 registry=json.loads((team/'registro.json').read_text());assert registry['worker']['body']==str(body)
 assert (body/'state/secretaria-gate-ok').read_text()==registry['worker']['pane_id']+'\n'
 command('office-status',['python3',str(cli),'--equipo',str(file),'estado','worker'])
 (work/'result.json').write_text(json.dumps({'actualPi':True,'actualHerdr':True,'isolatedNamedSession':True,'openingGate':True,'modelAndBackendTestDoubles':True,'productionAuthNotTested':True,'registry':registry},indent=2))
 print(f'OFFICE OPENING PASS: {work}; model/backend TEST DOUBLES; production authorization NOT tested')
finally:
 stop_exit=None
 if herdr_server is not None:
  stop=subprocess.run([herdr,'session','stop',session],env=server_env,capture_output=True,text=True,timeout=15)
  stop_exit=stop.returncode
  (work/'cleanup.stdout').write_text(stop.stdout);(work/'cleanup.stderr').write_text(stop.stderr);(work/'cleanup.exit').write_text(str(stop.returncode)+'\n')
  if herdr_server.poll() is None:
   try:herdr_server.wait(timeout=5)
   except subprocess.TimeoutExpired:herdr_server.terminate();herdr_server.wait(timeout=5)
 model_server.terminate();model_server.wait(timeout=10)
 proof={'session':session,'sessionStopExit':stop_exit,'serverExited':herdr_server is None or herdr_server.poll() is not None,'modelServerExited':model_server.poll() is not None}
 (work/'cleanup-proof.json').write_text(json.dumps(proof,indent=2))
 assert proof['serverExited'] and proof['modelServerExited'] and (herdr_server is None or stop_exit==0),proof
