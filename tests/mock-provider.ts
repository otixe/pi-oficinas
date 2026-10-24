import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
/** Test-only: deterministic loopback OpenAI fixture. Never included in an npm resource manifest. */
export default function(pi: ExtensionAPI) {
  const endpoint=process.env.PI_SMOKE_ENDPOINT;
  if(!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(endpoint))throw Error('Explicit loopback smoke endpoint required');
  pi.registerProvider('offline-smoke',{
    name:'Offline test fixture',baseUrl:endpoint,api:'openai-completions',apiKey:'$PI_SMOKE_KEY',
    models:[{type:'chat',id:'fixture',name:'Deterministic fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],
  });
}
