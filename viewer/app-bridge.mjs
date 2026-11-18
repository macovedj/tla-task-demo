/** Opt-in, same-origin connection to an application's existing browser instance. */
export class AppBridgeError extends Error {
  constructor(code, message) { super(message);this.name='AppBridgeError';this.code=code; }
}
const failure = (code, message) => new AppBridgeError(code, message);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function createClient(port, session, timeoutMs, cleanup) {
  let sequence = 0, closed = false, closedError = null;
  const pending = new Map(), listeners = new Set();
  const close = (reason = failure('APP_DISCONNECTED', 'The application bridge was closed.')) => {
    if (closed) return;
    closed = true;closedError = reason instanceof Error ? reason : failure('APP_DISCONNECTED', String(reason));
    port.removeEventListener('message', receive);port.removeEventListener('messageerror', broken);port.removeEventListener('close', broken);
    port.close();cleanup(closedError);
    for (const item of pending.values()) { clearTimeout(item.timer);item.reject(closedError); }
    pending.clear();
    for (const listener of [...listeners]) { try { listener(closedError); } catch { /* Other subscribers must still hear disconnect. */ } }
    listeners.clear();
  };
  const broken = () => close(failure('APP_DISCONNECTED', 'The application bridge disconnected.'));
  const receive = event => {
    const value = event.data;
    if (record(value) && value.version === 1 && value.type === 'tla-app-disconnected') {
      if (value.session === session) close(failure('APP_DISCONNECTED', typeof value.reason === 'string' ? value.reason : 'The application disconnected.'));
      return;
    }
    if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.id) || value.id < 1) return close(failure('APP_PROTOCOL_INVALID', 'The application returned an invalid bridge response.'));
    const item = pending.get(value.id);
    if (!item) return;
    if (Object.hasOwn(value,'result') === Object.hasOwn(value,'error') || (Object.hasOwn(value,'error') && (!record(value.error) || typeof value.error.message !== 'string'))) return close(failure('APP_PROTOCOL_INVALID', 'The application returned an invalid bridge response.'));
    clearTimeout(item.timer);pending.delete(value.id);
    if (Object.hasOwn(value,'error')) item.reject(failure('APP_ACTION_ERROR', value.error.message));
    else item.resolve(value.result);
  };
  port.addEventListener('message', receive);port.addEventListener('messageerror', broken);port.addEventListener('close', broken);port.start();
  return Object.freeze({
    request(method, action, binding) {
      if (closed) return Promise.reject(closedError);
      if (!['perform','observe','reset'].includes(method) || (method === 'perform' ? typeof action !== 'string' || !action || action.length > 128 : action !== undefined)) return Promise.reject(failure('APP_REQUEST_INVALID', 'Use perform(action), observe, or reset.'));
      if (!record(binding) || typeof binding.file !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(binding.file) || binding.file.startsWith('/') || binding.file.split('/').some(part => !part || part === '.' || part === '..') || typeof binding.function !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.function)) return Promise.reject(failure('APP_REQUEST_INVALID', 'Every application request needs its explicit source binding.'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(failure('APP_RPC_TIMEOUT', 'The application did not answer in time; reconnect before continuing.')), timeoutMs);
        pending.set(id, {resolve,reject,timer});
        try { port.postMessage({version:1,id,method,...(method === 'perform' ? {action} : {}),binding:{file:binding.file,function:binding.function}}); }
        catch { close(failure('APP_DISCONNECTED', 'The application request could not be sent.')); }
      });
    },
    close,
    onDisconnect(listener) {
      if (typeof listener !== 'function') throw new TypeError('Disconnect listener must be a function.');
      if (closed) { listener(closedError);return () => {}; }
      listeners.add(listener);return () => listeners.delete(listener);
    },
  });
}

export function connectParentApp({window:win = globalThis.window, timeoutMs = 15000} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(failure('APP_BRIDGE_INVALID', 'Bridge timeout must be between 1 and 60,000 milliseconds.'));
  if (!win || !win.location || new URLSearchParams(win.location.search).get('bridge') !== 'parent' || win.parent === win || !win.parent || !/^https?:\/\//.test(win.location.origin)) return Promise.reject(failure('APP_BRIDGE_UNAVAILABLE', 'Open the linked viewer inside its same-origin application lab.'));
  const origin = win.location.origin, parent = win.parent;
  return new Promise((resolve, reject) => {
    let client = null, session = null, settled = false;
    const cleanup = () => { win.removeEventListener('message', receive);win.removeEventListener('pagehide', unload); };
    const rejectConnection = error => { if (settled) return;settled=true;clearTimeout(timer);cleanup();reject(error); };
    const unload = () => client ? client.close(failure('APP_DISCONNECTED', 'The linked viewer was unloaded.')) : rejectConnection(failure('APP_DISCONNECTED', 'The linked viewer was unloaded.'));
    const receive = event => {
      if (event.origin !== origin || event.source !== parent || !record(event.data)) return;
      const value = event.data;
      if (value.type === 'tla-viewer-probe' && value.version === 1) {
        parent.postMessage({type:'tla-viewer-ready',version:1}, origin);
        return;
      }
      if (client) {
        if (value.type === 'tla-viewer-disconnect' && value.version === 1 && value.session === session) client.close(failure('APP_DISCONNECTED', typeof value.reason === 'string' ? value.reason : 'The application lab disconnected.'));
        if (value.type === 'tla-viewer-connect') for (const port of event.ports || []) port.close?.();
        return;
      }
      if (value.type !== 'tla-viewer-connect') return;
      const ports = event.ports || [];
      if (value.version !== 1 || typeof value.session !== 'string' || !value.session || value.session.length > 256 || ports.length !== 1 || typeof ports[0]?.postMessage !== 'function' || typeof ports[0]?.addEventListener !== 'function' || !record(value.manifest) || !Array.isArray(value.files) || !value.files.length || value.files.length > 100 || value.files.some(file => !record(file) || typeof file.name !== 'string' || typeof file.content !== 'string') || value.files.reduce((size,file) => size + file.content.length,0) > 3 * 1024 * 1024) {
        for (const port of ports) port.close?.();
        rejectConnection(failure('APP_BRIDGE_INVALID', 'The application lab sent an invalid connection.'));return;
      }
      let editProjectUrl;
      if (value.editProjectUrl !== undefined) {
        try {
          const url = new URL(value.editProjectUrl);
          if (url.protocol !== 'https:' || url.hostname !== 'edit-test.dev' || !/^\/p\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.username || url.password || url.port) throw new Error();
          editProjectUrl = url.href;
        } catch { ports[0].close();rejectConnection(failure('APP_BRIDGE_INVALID', 'The Edit project link is invalid.'));return; }
      }
      session = value.session;
      client = createClient(ports[0], session, timeoutMs, reason => {
        cleanup();
        try { parent.postMessage({type:'tla-viewer-disconnected',version:1,session,reason:reason.message}, origin); }
        catch { /* The parent may have unloaded. */ }
      });
      settled=true;clearTimeout(timer);
      resolve({client,manifest:structuredClone(value.manifest),files:value.files.map(file => ({name:file.name,content:file.content})),...(editProjectUrl ? {editProjectUrl} : {})});
    };
    const timer = setTimeout(() => rejectConnection(failure('APP_BRIDGE_TIMEOUT', 'The application lab did not connect in time.')), timeoutMs);
    win.addEventListener('message', receive);win.addEventListener('pagehide', unload);
    try { parent.postMessage({type:'tla-viewer-ready',version:1}, origin); }
    catch { rejectConnection(failure('APP_BRIDGE_UNAVAILABLE', 'The application lab could not be reached.')); }
  });
}
