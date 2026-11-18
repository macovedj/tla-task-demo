const VERSION = 1;
const MAX_QUEUED_REQUESTS = 32;
const METHODS = new Set(['perform', 'observe', 'reset']);
const STATUSES = new Set(['absent', 'open', 'done']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requestId = value => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) || (Number.isSafeInteger(value) && value >= 0);
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

function snapshot(value) {
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'status') || !STATUSES.has(value.status)) throw new Error('The app returned an invalid observation.');
  return { status: value.status };
}

/** Expose only this running app's explicit registry to its same-origin lab parent. */
export function installParentAppHost(adapter, { window: owner = globalThis.window } = {}) {
  if (!owner || owner.parent === owner || new URLSearchParams(owner.location.search).get('bridge') !== 'parent') return () => {};
  const origin = owner.location.origin;
  if (!/^https?:\/\//.test(origin)) return () => {};
  const actions = new Set(adapter.actions);
  let active = null;
  let disposed = false;

  function announce() {
    if (!disposed) owner.parent.postMessage({ type: 'tla-app-ready', version: VERSION }, origin);
  }
  function close(reason) {
    const connection = active;
    if (!connection) return;
    active = null;
    connection.closed = true;
    connection.port.removeEventListener('message', connection.receive);
    connection.port.removeEventListener('messageerror', connection.failed);
    const notice = { version: VERSION, type: 'tla-app-disconnected', session: connection.session, reason };
    try { connection.port.postMessage(notice); } catch { /* The peer may have left. */ }
    connection.port.close();
    try { owner.parent.postMessage(notice, origin); } catch { /* The parent may have left. */ }
  }
  function connect(port, session) {
    if (active?.session === session) { port.close(); return; }
    close('The app connection was replaced.');
    const connection = { port, session, closed: false, queued: 0, work: Promise.resolve() };
    const live = () => !disposed && active === connection && !connection.closed;
    function reply(id, body) {
      if (!live()) return;
      try { port.postMessage({ version: VERSION, id, ...body }); }
      catch { close('The app connection could not send a reply.'); }
    }
    function failure(id, message) { reply(id, { error: { message: String(message).slice(0, 512) } }); }
    connection.receive = event => {
      if (!live()) return;
      const message = event.data;
      if (!record(message) || !requestId(message.id)) return;
      const keys = Object.keys(message);
      if (message.version !== VERSION || !METHODS.has(message.method) || keys.some(key => !['version', 'id', 'method', 'action', 'binding'].includes(key)) || (message.method !== 'perform' && Object.hasOwn(message, 'action'))) {
        failure(message.id, 'Unsupported app request.');
        return;
      }
      if (message.method === 'perform' && (typeof message.action !== 'string' || message.action.length > 128 || !actions.has(message.action))) {
        failure(message.id, 'Unknown app action.');
        return;
      }
      const expectedBinding = message.method === 'perform' ? adapter.bindings?.actions?.[message.action] : adapter.bindings?.[message.method];
      if (!record(message.binding) || Object.keys(message.binding).length !== 2 || !expectedBinding || message.binding.file !== expectedBinding.file || message.binding.function !== expectedBinding.function) {
        failure(message.id, 'The requested source binding does not match the running app registration.');
        return;
      }
      if (connection.queued >= MAX_QUEUED_REQUESTS) {
        failure(message.id, 'The app request queue is full.');
        return;
      }
      // Copy accepted fields before enqueueing; no code or import path crosses this seam.
      const { id, method, action } = message;
      connection.queued++;
      connection.work = connection.work.then(async () => {
        if (!live()) return;
        try {
          if (method === 'perform') await adapter.perform(action);
          else if (method === 'reset') await adapter.reset();
          if (!live()) return;
          // The operation's return value is not evidence: read the live app again.
          const result = snapshot(await adapter.observe());
          reply(id, { result });
        } catch (error) {
          failure(id, error?.message || 'The app operation failed.');
        } finally {
          connection.queued--;
        }
      });
    };
    connection.failed = () => close('The app connection received an unreadable message.');
    active = connection;
    port.addEventListener('message', connection.receive);
    port.addEventListener('messageerror', connection.failed);
    port.start();
  }
  function receive(event) {
    if (disposed || event.origin !== origin || event.source !== owner.parent || !record(event.data) || event.data.version !== VERSION) return;
    const message = event.data;
    if (message.type === 'tla-app-probe') { announce(); return; }
    if (message.type === 'tla-app-disconnect' && message.session === active?.session) { close('The lab disconnected the app.'); return; }
    if (message.type !== 'tla-app-connect' || !sessionId(message.session) || event.ports?.length !== 1) return;
    const port = event.ports[0];
    if (typeof port?.postMessage !== 'function' || typeof port?.start !== 'function' || typeof port?.close !== 'function') return;
    connect(port, message.session);
  }
  function dispose() {
    if (disposed) return;
    close('The app page was closed or reloaded.');
    disposed = true;
    owner.removeEventListener('message', receive);
    owner.removeEventListener('pagehide', dispose);
  }
  owner.addEventListener('message', receive);
  owner.addEventListener('pagehide', dispose);
  announce();
  return dispose;
}
