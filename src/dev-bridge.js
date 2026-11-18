const VERSION = 1;
const VIEWER_ORIGIN = 'https://tla-state-explorer.djmacovei.chatgpt.site';
const EDIT_ORIGINS = new Set(['https://edit-test.dev', 'https://edit-staging.dev', 'https://edit.dev']);
const MAX_OFFERS = 8;
const MAX_QUEUE = 32;
const MAX_SOURCE_BYTES = 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = (value, max = 100) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const requestId = value => (Number.isSafeInteger(value) && value >= 0) || token(value, 80);
const encoder = new TextEncoder();

function relativeFile(file) {
  return typeof file === 'string' && /^[A-Za-z0-9_./-]{1,200}$/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
}
function registryFor(modules) {
  if (!record(modules) || !Object.keys(modules).length || Object.keys(modules).length > 100) throw new TypeError('Register between 1 and 100 source modules.');
  const registry = new Map();
  for (const [file, functions] of Object.entries(modules)) {
    if (!relativeFile(file) || !record(functions) || !Object.keys(functions).length || Object.keys(functions).length > 100) throw new TypeError('Register relative source files with 1–100 function references.');
    const exports = new Map();
    for (const [name, callback] of Object.entries(functions)) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name) || typeof callback !== 'function') throw new TypeError('Each registered export needs a name and a live function reference.');
      exports.set(name, callback);
    }
    registry.set(file, exports);
  }
  return registry;
}
function boundedJson(value, maxBytes, label) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable.`); }
  if (text !== undefined && encoder.encode(text).length > maxBytes) throw new Error(`${label} exceeds the development bridge size limit.`);
}

/** Opt-in development access to explicit live exports, independent of any model. */
export function installDevBridge({ id, title, modules }, {
  window: owner = globalThis.window,
  fetch: fetchSource = globalThis.fetch,
  MessageChannel: Channel = globalThis.MessageChannel,
  enabled = false,
  viewerOrigin = VIEWER_ORIGIN,
  offerTimeoutMs = 300000,
} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('The development bridge enabled option must be a boolean.');
  if (!owner || owner.parent === owner || (!enabled && new URLSearchParams(owner.location.search).get('devBridge') !== '1')) return () => {};
  let editOrigin;
  try { editOrigin = new URL(owner.document.referrer).origin; } catch { return () => {}; }
  if (!EDIT_ORIGINS.has(editOrigin) || !/^https?:\/\//.test(owner.location.origin)) return () => {};
  if (!token(id, 100) || typeof title !== 'string' || !title.trim() || title.length > 160) throw new TypeError('The development bridge needs a short app id and title.');
  const registry = registryFor(modules);
  const catalog = [...registry].map(([file, functions]) => ({ file, functions: [...functions.keys()] }));
  const ownOrigin = owner.location.origin;
  if (typeof viewerOrigin !== 'string' || new URL(viewerOrigin).origin !== viewerOrigin || !viewerOrigin.startsWith('https://')) throw new TypeError('Configure an exact HTTPS viewer origin.');
  const allowedViewers = new Set([ownOrigin, viewerOrigin]);
  const base = new URL('./', owner.location.href);
  const instance = owner.crypto.randomUUID();
  const offers = new Map();
  let active = null;
  let runningCalls = 0;
  let disposed = false;

  function close(offer, reason) {
    if (offer.closed) return;
    offer.closed = true;
    offers.delete(offer.session);
    if (active === offer) active = null;
    clearTimeout(offer.timer);
    offer.abort.abort();
    offer.port.removeEventListener('message', offer.receive);
    offer.port.removeEventListener('messageerror', offer.failed);
    offer.port.removeEventListener('close', offer.peerClosed);
    try { offer.port.postMessage({ type: 'edit-app-bridge:disconnected', version: VERSION, session: offer.session, reason }); } catch { /* Peer already gone. */ }
    offer.port.close();
  }
  function createOffer(event) {
    // Discovery never changes active ownership, even when the same viewer probes again.
    const pending = [...offers.values()].filter(offer => active !== offer);
    if (pending.length >= MAX_OFFERS) close(pending[0], 'The discovery offer was superseded.');
    const channel = new Channel();
    const offer = {
      session: owner.crypto.randomUUID(), port: channel.port1, closed: false,
      queued: 0, work: Promise.resolve(), abort: new AbortController(),
    };
    const live = () => !disposed && !offer.closed && offers.get(offer.session) === offer;
    const claimed = () => live() && active === offer;
    function reply(id, body) {
      if (!live()) return;
      try { offer.port.postMessage({ version: VERSION, session: offer.session, id, ...body }); }
      catch { close(offer, 'The development bridge could not send a reply.'); }
    }
    const failure = (id, message) => reply(id, { error: { message: String(message).slice(0, 512) } });
    offer.receive = event => {
      if (!live()) return;
      const message = event.data;
      if (!record(message) || !requestId(message.id)) return;
      if (message.version !== VERSION || message.session !== offer.session || !['claim', 'call', 'source', 'release', 'ping'].includes(message.method) || Object.keys(message).some(key => !['version', 'session', 'id', 'method', 'binding', 'file', 'args'].includes(key))) {
        failure(message.id, 'Unsupported or stale development bridge request.');
        return;
      }
      // Control messages stay responsive while an application function awaits work.
      if (message.method === 'ping') { reply(message.id, { result: { alive: true, claimed: active === offer } }); return; }
      if (message.method === 'claim') {
        if ((active && active !== offer) || (!active && runningCalls)) {
          failure(message.id, 'This app is already claimed or a previous call is still finishing.');
          return;
        }
        active = offer;
        clearTimeout(offer.timer);
        reply(message.id, { result: { claimed: true } });
        return;
      }
      if (message.method === 'release') {
        reply(message.id, { result: { released: true } });
        close(offer, 'The viewer released its development bridge connection.');
        return;
      }
      if (message.method === 'call' && active !== offer) { failure(message.id, 'Claim this app before calling exports.'); return; }
      let callback;
      let args;
      let sourceUrl;
      try {
        if (message.method === 'call') {
          if (!record(message.binding) || Object.keys(message.binding).length !== 2 || !Object.hasOwn(message.binding, 'file') || !Object.hasOwn(message.binding, 'function')) throw new Error('A call needs an explicitly registered file and export.');
          callback = registry.get(message.binding.file)?.get(message.binding.function);
          if (!callback) throw new Error('The source file or export is not registered.');
          if (!Array.isArray(message.args) || message.args.length > 32) throw new Error('A call needs an array of at most 32 arguments.');
          boundedJson(message.args, 65536, 'Arguments');
          args = message.args;
        } else if (message.method === 'source') {
          if (!registry.has(message.file)) throw new Error('The source file is not registered.');
          sourceUrl = new URL(message.file, base);
          if (sourceUrl.origin !== ownOrigin || !sourceUrl.pathname.startsWith(base.pathname)) throw new Error('Source must remain inside this application.');
        }
        if (offer.queued >= MAX_QUEUE) throw new Error('The development bridge request queue is full.');
      } catch (error) { failure(message.id, error.message); return; }
      const { id, method, file } = message;
      offer.queued++;
      offer.work = offer.work.then(async () => {
        try {
          if (!live()) return;
          if (method === 'call') {
            if (!claimed()) throw new Error('Claim this app before calling exports.');
            let result;
            runningCalls++;
            try { result = await callback(...args); }
            finally { runningCalls--; }
            if (!claimed()) return;
            boundedJson(result, MAX_SOURCE_BYTES, 'The function result');
            reply(id, { result });
          } else {
            const response = await fetchSource(sourceUrl.href, { cache: 'no-store', signal: offer.abort.signal });
            if (!response.ok) throw new Error(`Could not load the registered source file (${response.status}).`);
            const content = await response.text();
            if (!live()) return;
            if (encoder.encode(content).length > MAX_SOURCE_BYTES) throw new Error('The source file exceeds the 1 MiB limit.');
            reply(id, { result: { file, content } });
          }
        } catch (error) { failure(id, error?.message || 'The development bridge operation failed.'); }
        finally { offer.queued--; }
      });
    };
    offer.failed = () => close(offer, 'The development bridge received an unreadable message.');
    offer.peerClosed = () => close(offer, 'The viewer closed its development bridge port.');
    offer.port.addEventListener('message', offer.receive);
    offer.port.addEventListener('messageerror', offer.failed);
    offer.port.addEventListener('close', offer.peerClosed);
    offer.port.start();
    offer.timer = setTimeout(() => close(offer, 'The unclaimed discovery offer expired.'), offerTimeoutMs);
    offers.set(offer.session, offer);
    try {
      event.source.postMessage({ type: 'edit-app-bridge:offer', version: VERSION, nonce: event.data.nonce, session: offer.session, instance, id, title, modules: catalog }, event.origin, [channel.port2]);
    } catch {
      channel.port2.close();
      close(offer, 'The viewer could not receive its discovery offer.');
    }
  }
  function receive(event) {
    if (disposed || !record(event.data) || event.data.type !== 'edit-app-bridge:probe' || event.data.version !== VERSION || !token(event.data.nonce, 128) || event.ports?.length) return;
    if (!allowedViewers.has(event.origin)) return;
    try {
      if (!event.source || event.source === owner || event.source === owner.parent || event.source.parent !== owner.parent) return;
    } catch { return; }
    createOffer(event);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    owner.removeEventListener('message', receive);
    owner.removeEventListener('pagehide', dispose);
    for (const offer of [...offers.values()]) close(offer, 'The app page was closed or reloaded.');
  }
  owner.addEventListener('message', receive);
  owner.addEventListener('pagehide', dispose);
  return dispose;
}
