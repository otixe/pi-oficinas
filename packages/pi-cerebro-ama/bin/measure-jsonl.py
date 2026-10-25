#!/usr/bin/env python3
"""Offline Pi JSONL usage comparison. No provider, credential, prompt or tool-result output."""
import argparse,glob,json,math,statistics
from collections import defaultdict
from datetime import datetime,timezone
from pathlib import Path

def date(value):
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        return datetime.fromtimestamp(value/1000,timezone.utc)
    parsed=datetime.fromisoformat(str(value).replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Timestamp must include a timezone')
    return parsed.astimezone(timezone.utc)

def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
        raise ValueError('Invalid usage/cost number')
    return value

def median(values):return statistics.median(values) if values else None

def measure(config,high_tokens=10000,high_ratio=0.20):
    requests=[];diagnostics=defaultdict(int);seen_files=set();seen_calls=set()
    for item in config['sessions']:
        assert item['role'] in ['leader','office']
        assert item.get('phase','auto') in ['auto','baseline','ama','transition']
        perfil=item.get('perfil','subagente');before_perfil=item.get('perfil_before','subagente')
        assert perfil in ['lider','subagente'] and before_perfil in ['lider','subagente']
        profile_cutoff=date(item['perfil_cutoff']) if item.get('perfil_cutoff') else None
        cutoff=date(item.get('cutoff',config.get('cutoff'))) if item.get('phase','auto')=='auto' else None
        started=date(item['deployment_started']) if item.get('deployment_started') else cutoff
        for pattern in item['paths']:
            paths=sorted(glob.glob(pattern,recursive=False))
            if not paths:diagnostics['unmatched_patterns']+=1
            for name in paths:
                path=Path(name).resolve()
                if path in seen_files:diagnostics['duplicate_files']+=1;continue
                seen_files.add(path);entries=[];header=None
                with path.open(encoding='utf-8') as stream:
                    for line_no,line in enumerate(stream,1):
                        try:e=json.loads(line)
                        except (ValueError,TypeError):diagnostics['invalid_json_lines']+=1;continue
                        if not isinstance(e,dict):diagnostics['invalid_entries']+=1;continue
                        if e.get('type')=='session' and header is None:header=e
                        elif e.get('type')=='message':entries.append((line_no,e))
                session_start=None
                if header:
                    try:session_start=date(header['timestamp'])
                    except (KeyError,ValueError,TypeError,OverflowError):diagnostics['invalid_session_timestamps']+=1
                candidates=[]
                for line_no,e in entries:
                    m=e.get('message',{})
                    if not isinstance(m,dict) or m.get('role')!='assistant':continue
                    if m.get('stopReason')=='pending':diagnostics['pending_messages']+=1;continue
                    try:
                        u=m['usage'];tokens=sum(number(u[k]) for k in ['input','cacheRead','cacheWrite'])
                        cached=number(u['cacheWrite']);cost=u.get('cost',{})
                        usd=number(cost['total']) if 'total' in cost else sum(number(cost[k]) for k in ['input','output','cacheRead','cacheWrite'])
                        when=date(m.get('timestamp',e.get('timestamp')))
                        model=m['model'];provider=m['provider']
                        if not isinstance(model,str) or not isinstance(provider,str):raise ValueError('Invalid model/provider')
                    except (KeyError,ValueError,TypeError,OverflowError):diagnostics['unusable_assistant_usage']+=1;continue
                    # Forks/imports can copy earlier assistant history; that is not a new request.
                    if session_start and when<session_start:diagnostics['inherited_history_messages']+=1;continue
                    key=(item.get('body',item['house']+':'+item['role']),provider,model,m.get('responseId') or (e.get('id'),when.isoformat()))
                    if e.get('id') is None and m.get('responseId') is None:key=(*key,str(path),line_no)
                    if key in seen_calls:diagnostics['duplicate_requests']+=1;continue
                    seen_calls.add(key)
                    candidates.append({'date':when.isoformat(),'provider':provider,'model':model,'response_model':m.get('responseModel'),'input_tokens':tokens,'input':u['input'],'cache_read':u['cacheRead'],'cache_write':cached,'cost_per_request_usd':usd,'stop_reason':m.get('stopReason'),'line':line_no})
                if not candidates:diagnostics['sessions_without_new_usable_requests']+=1;continue
                if session_start is None:
                    session_start=min(date(x['date']) for x in candidates);diagnostics['start_inferred_from_first_request']+=1
                phase=item.get('phase','auto')
                if phase=='auto':phase='baseline' if session_start<started else 'transition' if session_start<cutoff else 'ama'
                session_perfil=before_perfil if profile_cutoff and session_start<profile_cutoff else perfil
                for index,r in enumerate(candidates):
                    requests.append({**r,'house':item['house'],'role':item['role'],'perfil':session_perfil,'body':item.get('body'),'session_file':str(path),'session_start':session_start.isoformat(),'phase':phase,'first_request':index==0,'high_cache_write':r['cache_write']>=high_tokens and r['cache_write']/max(r['input_tokens'],1)>=high_ratio})
    groups=defaultdict(list)
    for r in requests:groups[(r['house'],r['role'],r['perfil'],r['phase'],r['provider'],r['model'],'high-cache-write' if r['high_cache_write'] else 'normal')].append(r)
    summaries=[]
    for (house,role,perfil,phase,provider,model,cache),rows in sorted(groups.items()):
        first=[r['input_tokens'] for r in rows if r['first_request']]
        summaries.append({'house':house,'role':role,'perfil':perfil,'phase':phase,'provider':provider,'model':model,'cache_partition':cache,'requests':len(rows),'sessions':len({r['session_file'] for r in rows}),'first_request_tokens':first,'median_first_request_tokens':median(first),'median_input_tokens_per_request':median([r['input_tokens'] for r in rows]),'mean_cost_per_request_usd':sum(r['cost_per_request_usd'] for r in rows)/len(rows),'median_cost_per_request_usd':median([r['cost_per_request_usd'] for r in rows])})
    comparisons=[];pairs=defaultdict(dict)
    for g in summaries:pairs[(g['house'],g['role'],g['perfil'],g['provider'],g['model'],g['cache_partition'])][g['phase']]=g
    for key,phases in sorted(pairs.items()):
        if 'baseline' not in phases or 'ama' not in phases:continue
        b=phases['baseline'];a=phases['ama'];changes={}
        for metric in ['median_first_request_tokens','median_input_tokens_per_request','mean_cost_per_request_usd','median_cost_per_request_usd']:
            old=b[metric];new=a[metric];changes[metric]={'baseline':old,'ama':new,'percent_change':100*(new-old)/old if old is not None and new is not None and old!=0 else None}
        comparisons.append({'house':key[0],'role':key[1],'perfil':key[2],'provider':key[3],'model':key[4],'cache_partition':key[5],'metrics':changes})
    return {'format_version':2,'high_cache_write_threshold':{'tokens':high_tokens,'ratio':high_ratio},'limits':['Profile is manifest-declared or inferred from a session-start profile cutoff, not proof of live exposure. Confirm perfil_cb in a new owner process; never compare different profiles.','After-cutoff AMA is inferred from new-session start time, not proof of whoami/exposure. Old panes remain baseline even after deployment.','Transition sessions are separate; inherited/forked history is excluded and repeated request IDs deduplicated.','Main assistant requests only; nested tool/model usage excluded. Recorded costs may be zero or estimates. No universal or causal savings claim.','High cacheWrite is a diagnostic signal, not proof of mid-session tool activation. Compare like models and representative workloads.'],'diagnostics':dict(diagnostics),'files_read':len(seen_files),'requests':requests,'groups':summaries,'comparisons':comparisons}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('--output');p.add_argument('--high-cache-write-tokens',type=int,default=10000);p.add_argument('--high-cache-write-ratio',type=float,default=.20);a=p.parse_args()
    if a.high_cache_write_tokens<0 or not 0<=a.high_cache_write_ratio<=1:p.error('Invalid cacheWrite threshold')
    result=measure(json.loads(Path(a.manifest).read_text()),a.high_cache_write_tokens,a.high_cache_write_ratio);text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if a.output:
        out=Path(a.output).resolve();manifest=Path(a.manifest).resolve()
        if out==manifest or out.suffix=='.jsonl':p.error('Refuse to overwrite manifest/session input')
        with out.open('x',encoding='utf-8') as f:f.write(text)
    else:print(text,end='')
if __name__=='__main__':main()
