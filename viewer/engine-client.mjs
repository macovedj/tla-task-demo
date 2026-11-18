// The only model transport is postMessage to a same-origin local Web Worker.
// No file contents, diagnostics, or results are sent over HTTP.
let worker = null;
let initialization = null;
let ready = false;
let sequence = 0;
const pending = new Map();
const listeners = new Set();
let currentState = {status:'loading',message:'Loading the browser model checker…'};

function updateState(status,message) {
  currentState={status,message};
  for(const listener of listeners)listener(currentState);
}
export function onAnalyzerState(listener) {
  listeners.add(listener);
  listener(currentState);
  return ()=>listeners.delete(listener);
}
function errorFrom(value) {
  const error=new Error(value?.message||'The browser model checker failed.');
  error.code=value?.code||'BROWSER_ENGINE_ERROR';
  error.details=value?.details;
  return error;
}
function shutdown(error) {
  worker?.terminate();
  worker=null;ready=false;initialization=null;
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}
  pending.clear();
}
function request(type,payload,timeoutMs) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      const error=errorFrom({code:'BROWSER_TIMEOUT',message:type==='init'?'The browser engine could not load in time. Reload the page to retry.':'Analysis reached the 30-second browser time limit. Try smaller constants or a tighter state constraint.'});
      shutdown(error);updateState('error',error.message);
    },timeoutMs);
    pending.set(id,{resolve,reject,timer,type});
    try { worker.postMessage({id,type,...(payload?{payload}:{})}); }
    catch(cause){
      clearTimeout(timer);pending.delete(id);
      const error=errorFrom({code:'BROWSER_MESSAGE_ERROR',message:'The browser could not start this analysis: '+cause.message});
      if(type==='init'){shutdown(error);updateState('error',error.message);}
      else updateState('ready','tla-rs · runs in this browser');
      reject(error);
    }
  });
}
export function initializeAnalyzer() {
  if(ready)return Promise.resolve();
  if(initialization)return initialization;
  if(typeof Worker==='undefined'||typeof WebAssembly==='undefined'){
    const error=errorFrom({code:'BROWSER_UNSUPPORTED',message:'This browser needs WebAssembly and Web Workers to analyze TLA+ files.'});
    updateState('error',error.message);return Promise.reject(error);
  }
  updateState('loading','Loading the browser model checker…');
  try {
    const instance=new Worker(new URL('./engine-worker.mjs',import.meta.url),{type:'module',name:'tla-local-analysis'});
    worker=instance;
    instance.onmessage=event=>{
      if(worker!==instance)return;
      const message=event.data||{},item=pending.get(message.id);
      if(!item)return;
      if(message.type==='progress'){
        if(message.phase==='checking')updateState('running','Analyzing locally in your browser…');
        return;
      }
      if(message.type!=='error'&&!(message.type==='ready'&&item.type==='init')&&!(message.type==='result'&&['explore','step-init','step-next'].includes(item.type)))return;
      clearTimeout(item.timer);pending.delete(message.id);
      if(message.type==='error'){
        const error=errorFrom(message.error);
        if(item.type==='init'){shutdown(error);updateState('error',error.message);}
        else updateState('ready','tla-rs · runs in this browser');
        item.reject(error);return;
      }
      if(message.type==='ready'){ready=true;updateState('ready','tla-rs · runs in this browser');item.resolve();return;}
      if(message.type==='result'){updateState('ready','tla-rs · runs in this browser');item.resolve(message.result);}
    };
    instance.onerror=event=>{
      event.preventDefault();
      if(worker!==instance)return;
      const error=errorFrom({code:'BROWSER_ENGINE_CRASH',message:'The browser engine stopped unexpectedly. Try a smaller model or reload the page.'});
      shutdown(error);updateState('error',error.message);
    };
    const attempt=request('init',null,30000).catch(error=>{if(initialization===attempt)initialization=null;throw error;});
    initialization=attempt;
    return attempt;
  } catch(error) {
    shutdown(error);updateState('error',error.message);return Promise.reject(error);
  }
}
export async function analyzeInBrowser(payload) {
  await initializeAnalyzer();
  if([...pending.values()].some(item=>item.type!=='init'))throw errorFrom({code:'RUN_BUSY',message:'A browser analysis or trace expansion is already running.'});
  return request('explore',payload,30000);
}
export async function startBrowserTrace(payload) {
  await initializeAnalyzer();
  if([...pending.values()].some(item=>item.type!=='init'))throw errorFrom({code:'RUN_BUSY',message:'A browser analysis or trace expansion is already running.'});
  return request('step-init',payload,30000);
}
export async function nextBrowserTrace(payload) {
  await initializeAnalyzer();
  if([...pending.values()].some(item=>item.type!=='init'))throw errorFrom({code:'RUN_BUSY',message:'A browser analysis or trace expansion is already running.'});
  return request('step-next',payload,30000);
}
export function cancelBrowserAnalysis() {
  const error=errorFrom({code:'BROWSER_CANCELLED',message:'Analysis cancelled. Your files stayed in this browser.'});
  shutdown(error);updateState('loading','Restarting the browser model checker…');
}
