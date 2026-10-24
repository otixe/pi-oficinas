"""Test-only loopback model/backend. Logs tool names, never credentials or prompts.
Not part of any package tarball. Does not simulate real backend authorization.
"""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--work',required=True)
args=parser.parse_args()
work=Path(args.work)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def json(self,value,status=200):
        self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(value).encode())
    def do_GET(self):
        if self.path.startswith('/agents/registry'): self.json({'agents':[]})
        elif self.path.startswith('/checkpoint/agent-latest'):self.json({'found':False})
        elif self.path.startswith('/task/list'):self.json({'tasks':[]})
        elif self.path.startswith('/vm-turno'):self.json({'holder':None})
        elif self.path.startswith('/mail'):self.json({'items':[]})
        else:self.json({'error':'not found'},404)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path!='/v1/chat/completions':return self.json({'error':'not found'},404)
        time.sleep(1) # expose a real working interval to Herdr, not a sub-poll instant reply
        names=[t.get('function',{}).get('name') for t in body.get('tools',[])]
        with (work/'model-tools.jsonl').open('a') as f:f.write(json.dumps({'tools':names})+'\n')
        text='OFFLINE_SMOKE_OK '+json.dumps(names)
        # Fresh tool calls are driven by the exact opening challenge, not preloaded receipts.
        messages=body.get('messages',[])
        last_user=next((m for m in reversed(messages) if m.get('role')=='user'),{})
        opening='IDENT:' in str(last_user.get('content','')) and 'cb_whoami' in str(last_user.get('content',''))
        after_user=messages[messages.index(last_user)+1:] if last_user in messages else []
        results=[m for m in after_user if m.get('role')=='tool']
        if opening and not results:
            calls=[{'index':0,'id':'fixture-who','type':'function','function':{'name':'cb_whoami','arguments':'{}'}},
                   {'index':1,'id':'fixture-soul','type':'function','function':{'name':'cb_vault_read','arguments':json.dumps({'path':'50 Agents/Example/Equipo/worker/Vigente/SOUL.md'})}}]
            delta={'role':'assistant','tool_calls':calls};finish='tool_calls'
        else:
            if opening:text='IDENT:worker (subagente)|ALMA:worker|TELEGRAM:NINGUNA'
            delta={'role':'assistant','content':text};finish='stop'
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        for d,reason in [(delta,None),({},finish)]:
            chunk={'id':'fixture','object':'chat.completion.chunk','created':int(time.time()),'model':'fixture','choices':[{'index':0,'delta':d,'finish_reason':reason}]}
            self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(work/'endpoint.txt').write_text(f'http://127.0.0.1:{server.server_port}')
server.serve_forever()
