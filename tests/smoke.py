"""Isolated real-Pi package/load smoke with a deterministic loopback provider.
Run with HOME=$(mktemp -d -p "$HOME/work") and an explicit --pi host executable.
All outputs/archives/extracted packages remain in that disposable HOME. No cloud model.
"""
import argparse, json, os, pwd, subprocess, tarfile, time
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--pi',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
home=Path.home();work_base=(Path(pwd.getpwuid(os.getuid()).pw_dir)/'work').resolve()
assert home.is_absolute() and home.resolve()!=work_base and home.resolve().is_relative_to(work_base), 'HOME must be an isolated child directory of the OS user work directory'
assert not (home/'.pi').exists(), 'HOME must be new/empty'
work=home/'smoke';work.mkdir();artifacts=work/'artifacts';artifacts.mkdir();cwd=work/'cwd';cwd.mkdir()
temp=home/'tmp';temp.mkdir(mode=0o700,exist_ok=True)
pi=str(Path(args.pi).absolute())
env={'HOME':str(home),'TMPDIR':str(temp),'PYTHONDONTWRITEBYTECODE':'1','PATH':f'{Path(pi).parent}:/usr/bin:/bin','LANG':'C.UTF-8','PI_SMOKE_KEY':'offline-fixture-not-a-real-credential'}

def run(name,command,where=cwd,extra=None,allow_failure=False):
    result=subprocess.run(command,cwd=where,env={**env,**(extra or {})},capture_output=True,text=True,timeout=100)
    (work/f'{name}.stdout').write_text(result.stdout);(work/f'{name}.stderr').write_text(result.stderr)
    (work/f'{name}.exit').write_text(str(result.returncode)+'\n')
    if result.returncode and not allow_failure:raise RuntimeError(f'{name}: exit {result.returncode}; inspect {work}')
    return result
server=subprocess.Popen(['python3',str(root/'tests/fixture-server.py'),'--work',str(work)],env=env,stdout=subprocess.DEVNULL,stderr=(work/'server.stderr').open('w'))
try:
    for _ in range(100):
        if (work/'endpoint.txt').exists():break
        time.sleep(.05)
    base=(work/'endpoint.txt').read_text();env['PI_SMOKE_ENDPOINT']=base+'/v1'
    prompt_args=[pi,'-p','-e',str(root/'tests/mock-provider.ts'),'--model','offline-smoke/fixture','--thinking','off','Package load smoke']
    archives=[]
    # AMA is a replacement bridge/activator, not a sixth member of this combined loadout.
    # Its packaged contracts and separate no-provider SDK acceptance cover that route.
    original_packages=[p for p in sorted((root/'packages').iterdir()) if p.name!='pi-cerebro-ama']
    assert {p.name for p in original_packages}=={'pi-oficinas','pi-cache-estable','pi-renovacion','pi-plan-gate','pi-herramientas'}
    for package in original_packages:
        r=run('pack-'+package.name,['npm','pack','--json','--pack-destination',str(artifacts)],package)
        packed=json.loads(r.stdout);record=packed[0] if isinstance(packed,list) else next(iter(packed.values()))
        assert all(not any(part in ['node_modules','__pycache__','tests'] for part in Path(f['path']).parts) and '.bak' not in f['path'] and not f['path'].endswith('.pyc') and Path(f['path']).name!='.env' for f in record['files']),record['files']
        archive=artifacts/record['filename'];archives.append((package.name,archive))
        run('literal-install-'+package.name,[pi,'install','./'+archive.name],artifacts)
    literal=run('literal-print',prompt_args,allow_failure=True)
    run('literal-list',[pi,'list'])
    for name,archive in archives:run('literal-remove-'+name,[pi,'remove','./'+archive.name],artifacts)
    independent={}
    for name,archive in archives:
        destination=work/'installed'/name;destination.mkdir(parents=True)
        with tarfile.open(archive) as t:
            assert all(not p.issym() and not p.islnk() and not p.name.startswith('/') and '..' not in Path(p.name).parts for p in t.getmembers())
            t.extractall(destination,filter='data')
        source=str(destination/'package')
        run('independent-install-'+name,[pi,'install',source])
        isolated=run('independent-print-'+name,prompt_args)
        assert 'OFFLINE_SMOKE_OK' in isolated.stdout and not any(s in isolated.stderr for s in ['Failed to load','Error:','TOOLS_ORDER_UNSUPPORTED_HOST']),isolated.stderr
        independent[name]=True
        run('independent-remove-'+name,[pi,'remove',source])
    for name,archive in archives:
        run('extracted-install-'+name,[pi,'install',str(work/'installed'/name/'package')])
    r=run('unconfigured-print',prompt_args)
    assert 'OFFLINE_SMOKE_OK' in r.stdout
    assert not any(s in r.stderr for s in ['Failed to load','Error:','TOOLS_ORDER_UNSUPPORTED_HOST']),r.stderr
    # Real package factories under an explicit matching leader body. Backend is a test fixture.
    team=work/'team';body=team/'coordinator';body.mkdir(parents=True);(team/'worker').mkdir()
    cfg={'version':2,'lider':'coordinator','lider_key_env':'TEAM_COORDINATOR_KEY','office_key_prefix':'TEAM_OFFICE_KEY_','base':str(team),'lider_body':str(body),'soul_prefix':'50 Agents/Example/Equipo','oficinas':['worker'],'distribucion':'distribucion.json','secretaria':{'monitor':False,'avisos':False,'contexto':False,'correo':False}}
    file=team/'equipo.json';file.write_text(json.dumps(cfg));file.chmod(0o600)
    (body/'.pi').mkdir();(body/'.pi/herramientas.json').write_text(json.dumps({'base':'*','grupos':{'editing':{'linea':'Enable editing tools','tools':['edit','write']}}}));(body/'.pi/tools-order.json').write_text(json.dumps({'version':1,'priority':['read','bash','edit','write','plan_*'],'unlisted':'alphabetical'}))
    (body/'.env').write_text(f'PI_OFICINAS_EQUIPO={file}\nAGENT_NAME=coordinator\nBODY_ROLE=leader\nAGENT_ENABLED=1\nCEREBRO_BASE={base}\n');(body/'.env').chmod(0o600)
    extra={'PI_OFICINAS_EQUIPO':str(file),'CEREBRO_BASE':base,'TEAM_COORDINATOR_KEY':'offline-team-fixture'}
    r=run('configured-print',prompt_args,body,extra)
    assert 'OFFLINE_SMOKE_OK' in r.stdout
    assert not any(s in r.stderr for s in ['Failed to load','Error:','TOOLS_ORDER_UNSUPPORTED_HOST']),r.stderr
    actual=json.loads((work/'model-tools.jsonl').read_text().splitlines()[-1])['tools']
    expected=['herramientas_activar','plan_mode','plan_submit','plan_check','oficina_asignar','oficina_estado','oficina_responder','vm_turno']
    assert all(n in actual for n in expected),{'expected':expected,'actual':actual}
    run('extracted-list',[pi,'list'])
    results={'fiveTarballs':True,'literalInstallExit':0,'literalPrintExit':literal.returncode,'literalTarballIsNotProofOfLoad':True,'independentPackageLoads':independent,'extractedPrint':True,'configuredTools':actual,'loopbackFixtureOnly':True,'officeOpeningNotCoveredYet':True}
    (work/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({'home':str(home),'work':str(work),'result':results},indent=2))
finally:
    server.terminate();server.wait(timeout=10)
