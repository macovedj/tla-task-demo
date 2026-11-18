import * as engine from './vendor/tla-checker/tla_checker.js';
import wasmBytes from './vendor/tla-checker/wasm-bytes.mjs';
import { analyzeBrowserModel, initializeBrowserTrace, expandBrowserTrace } from './lib/browser-engine.mjs';

let initialization;
let running = false;
function disableNetwork() {
  const blocked = () => { throw new Error('Network access is disabled while analyzing local specifications.'); };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts']) {
    try { Object.defineProperty(globalThis, name, { value: blocked, configurable: false, writable: false }); }
    catch { globalThis[name] = blocked; }
  }
}
function initialize() {
  initialization ??= Promise.resolve().then(() => {
    disableNetwork();
    engine.initSync({ module: wasmBytes });
    return true;
  });
  return initialization;
}
function sendError(id, error) {
  postMessage({ id, type: 'error', error: { code: error.code || 'ENGINE_FAILURE', message: error.message || String(error), ...(error.details ? { details: error.details } : {}) } });
}
self.onmessage = async event => {
  const { id, type, payload } = event.data || {};
  if (!['init', 'explore', 'step-init', 'step-next'].includes(type)) return;
  if (running) { sendError(id, { code: 'ENGINE_BUSY', message: 'The browser engine is already running a model.' }); return; }
  running = true;
  try {
    postMessage({ id, type: 'progress', phase: 'loading' });
    await initialize();
    if (type === 'init') { postMessage({ id, type: 'ready' }); return; }
    postMessage({ id, type: 'progress', phase: 'checking' });
    const result = type === 'step-init' ? initializeBrowserTrace(engine, payload) : type === 'step-next' ? expandBrowserTrace(engine, payload) : analyzeBrowserModel(engine, payload);
    postMessage({ id, type: 'result', result });
  } catch (error) { sendError(id, error); }
  finally { running = false; }
};
