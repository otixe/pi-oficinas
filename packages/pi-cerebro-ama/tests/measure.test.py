import importlib.util,json,tempfile,unittest,hashlib,shutil,subprocess
from pathlib import Path
E=Path(tempfile.gettempdir());P=Path(__file__).resolve().parents[1]/'bin/measure-jsonl.py'
s=importlib.util.spec_from_file_location('measure',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Measurement(unittest.TestCase):
 def setUp(self):self.d=Path(tempfile.mkdtemp(prefix='measure-',dir=E))
 def tearDown(self):shutil.rmtree(self.d)
 def session(self,name,start,rows):
  p=self.d/(name+'.jsonl');p.write_text('\n'.join(json.dumps(e) for e in [{'type':'session','timestamp':start,'id':name}]+rows)+'\n');return str(p)
 def row(self,ident,when,tokens=100,cached=0,cost=.1):
  return {'type':'message','id':ident,'message':{'role':'assistant','model':'test','provider':'offline','timestamp':int(m.date(when).timestamp()*1000),'stopReason':'stop','usage':{'input':tokens,'cacheRead':20,'cacheWrite':cached,'cacheWrite1h':cached,'output':7,'cost':{'total':cost}},'content':[{'type':'text','text':'PRIVATE CONTENT MUST NOT APPEAR'}]}}
 def config(self,paths):return {'sessions':[{'house':'demo','role':'office','body':'demo-author','cutoff':'2026-01-01T12:00:00Z','deployment_started':'2026-01-01T11:59:00Z','paths':paths}]}
 def test_sum_cost_medians_comparison_and_readonly(self):
  a=self.session('old','2026-01-01T10:00:00Z',[self.row('a','2026-01-01T10:01:00Z',100),self.row('b','2026-01-01T12:30:00Z',140)])
  b=self.session('new','2026-01-01T13:00:00Z',[self.row('c','2026-01-01T13:01:00Z',60,cost=.05),self.row('d','2026-01-01T13:02:00Z',80,cost=.05)])
  seals={x:hashlib.sha256(Path(x).read_bytes()).hexdigest() for x in [a,b]};r=m.measure(self.config([a,b]));self.assertEqual([x['phase'] for x in r['requests']],['baseline','baseline','ama','ama']);c=r['comparisons'][0]['metrics'];self.assertEqual(c['median_input_tokens_per_request']['baseline'],140);self.assertEqual(c['median_input_tokens_per_request']['ama'],90);self.assertEqual(c['mean_cost_per_request_usd']['percent_change'],-50);self.assertEqual(c['median_first_request_tokens']['baseline'],120);self.assertNotIn('PRIVATE CONTENT',json.dumps(r));self.assertEqual(seals,{x:hashlib.sha256(Path(x).read_bytes()).hexdigest() for x in [a,b]})
 def test_transition_high_cache_and_no_cachewrite1h_double_count(self):
  a=self.session('transition','2026-01-01T11:59:30Z',[self.row('t','2026-01-01T12:01:00Z',cached=20000)])
  r=m.measure(self.config([a]));self.assertEqual(r['requests'][0]['phase'],'transition');self.assertEqual(r['requests'][0]['input_tokens'],20120);self.assertTrue(r['requests'][0]['high_cache_write']);self.assertEqual(r['groups'][0]['cache_partition'],'high-cache-write');self.assertEqual(r['comparisons'],[])
 def test_fork_history_and_duplicate_files_requests(self):
  row=self.row('same','2026-01-01T10:01:00Z');a=self.session('old','2026-01-01T10:00:00Z',[row]);b=self.session('duplicate','2026-01-01T10:00:00Z',[row]);c=self.session('fork','2026-01-01T13:00:00Z',[row,self.row('new','2026-01-01T13:01:00Z')]);r=m.measure(self.config([a,a,b,c]));self.assertEqual(len(r['requests']),2);self.assertEqual(r['diagnostics']['duplicate_files'],1);self.assertEqual(r['diagnostics']['duplicate_requests'],1);self.assertEqual(r['diagnostics']['inherited_history_messages'],1)
 def test_invalid_usage_is_not_fake_zero_and_nested_usage_excluded(self):
  bad=self.row('bad','2026-01-01T10:01:00Z');bad['message']['usage']['input']=True
  a=self.session('bad','2026-01-01T10:00:00Z',[bad,{'type':'message','message':{'role':'toolResult','usage':{'input':99999}}}]);with_invalid=Path(a);with_invalid.write_text(with_invalid.read_text()+'{bad\n');r=m.measure(self.config([a]));self.assertEqual(r['requests'],[]);self.assertEqual(r['diagnostics']['unusable_assistant_usage'],1);self.assertEqual(r['diagnostics']['invalid_json_lines'],1)
 def test_cli_output_is_exclusive(self):
  a=self.session('old','2026-01-01T10:00:00Z',[self.row('a','2026-01-01T10:01:00Z')]);cfg=self.d/'manifest.json';cfg.write_text(json.dumps(self.config([a])));out=self.d/'result.json';cmd=['python3',str(P),str(cfg),'--output',str(out)];p=subprocess.run(cmd,capture_output=True);self.assertEqual(p.returncode,0);seal=out.read_bytes();p=subprocess.run(cmd,capture_output=True);self.assertNotEqual(p.returncode,0);self.assertEqual(out.read_bytes(),seal)
 def test_profiles_separate_same_role_model_and_prevent_cross_profile_comparison(self):
  a=self.session('old','2026-01-01T10:00:00Z',[self.row('a','2026-01-01T10:01:00Z')]);b=self.session('new','2026-01-01T13:00:00Z',[self.row('b','2026-01-01T13:01:00Z')]);cfg=self.config([a]);cfg['sessions'][0]['role']='leader';other={**cfg['sessions'][0],'paths':[b],'perfil':'lider'};cfg['sessions'].append(other);r=m.measure(cfg)
  self.assertEqual({g['perfil'] for g in r['groups']},{'lider','subagente'});self.assertEqual(r['comparisons'],[]);self.assertEqual(r['format_version'],2)
 def test_profile_cutoff_retains_legacy_eight_profile_for_old_leader_session(self):
  a=self.session('old','2026-01-01T13:00:00Z',[self.row('a','2026-01-01T15:00:00Z')]);b=self.session('new','2026-01-01T14:30:00Z',[self.row('b','2026-01-01T15:01:00Z')]);cfg=self.config([a,b]);cfg['sessions'][0].update(role='leader',perfil='lider',perfil_before='subagente',perfil_cutoff='2026-01-01T14:00:00Z');r=m.measure(cfg)
  self.assertEqual([x['perfil'] for x in r['requests']],['subagente','lider']);self.assertEqual([x['phase'] for x in r['requests']],['ama','ama']);self.assertEqual(len(r['groups']),2)
 def test_explicit_profile_comparison_and_invalid_profile(self):
  a=self.session('old','2026-01-01T10:00:00Z',[self.row('a','2026-01-01T10:01:00Z')]);b=self.session('new','2026-01-01T13:00:00Z',[self.row('b','2026-01-01T13:01:00Z')]);cfg=self.config([a,b]);cfg['sessions'][0]['perfil']='lider';r=m.measure(cfg);self.assertEqual(r['comparisons'][0]['perfil'],'lider')
  cfg['sessions'][0]['perfil']='admin'
  with self.assertRaises(AssertionError):m.measure(cfg)
if __name__=='__main__':unittest.main()
