import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { installDevBridge } from '../src/dev-bridge.js';
import { addTask, completeTask, reopenTask, deleteTask, observe, reset, setFaultInjection } from '../src/task-app.js';

const VIEWER = 'https://tla-state-explorer.djmacovei.chatgpt.site';
const FILE = 'src/task-app.js';
const actualFunctions = { addTask, completeTask, reopenTask, deleteTask, observe, reset };
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeWindow extends EventTarget {
  constructor({ search = '?devBridge=1', referrer = 'https://edit-test.dev/p/example' } = {}) {
    super();
    this.parent = {};
    this.location = { origin: 'https://project.preview.example', href: `https://project.preview.example/__edit_file__/app/index.html${search}`, search };
    this.document = { referrer };
    let session = 0;
    this.crypto = { randomUUID: () => `session-${++session}` };
  }
  probe(source, overrides = {}) {
    const event = new Event('message');
    Object.assign(event, { source, origin: VIEWER, ports: [], data: { type: 'edit-app-bridge:probe', version: 1, nonce: 'nonce-123' }, ...overrides });
    this.dispatchEvent(event);
  }
}
function receive(port, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port.removeEventListener('message', handler); reject(new Error('No development bridge response.')); }, 1000);
    function handler(event) {
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      port.removeEventListener('message', handler);
      resolve(event.data);
    }
    port.addEventListener('message', handler);
    port.start();
  });
}
function mount(t, { functions = actualFunctions, fetch, offerTimeoutMs, viewerOrigin = VIEWER, enabled, unframed = false, ...windowOptions } = {}) {
  const owner = new FakeWindow(windowOptions);
  if (unframed) owner.parent = owner;
  const fetches = [];
  const dispose = installDevBridge({ id: 'one-task', title: 'One Task', modules: { [FILE]: functions } }, {
    window: owner,
    MessageChannel,
    viewerOrigin,
    ...(enabled === undefined ? {} : { enabled }),
    fetch: fetch || (async (url, options) => { fetches.push({ url, options }); return { ok: true, text: async () => '// Registered source' }; }),
    ...(offerTimeoutMs === undefined ? {} : { offerTimeoutMs }),
  });
  const clients = [];
  function viewer() {
    const offers = [];
    const source = { parent: owner.parent, postMessage: (message, origin, ports) => {
      assert.ok(origin === viewerOrigin || origin === owner.location.origin);
      assert.equal(ports.length, 1);
      const port = ports[0];
      port.start();
      let nextId = 0;
      const client = {
        message, port,
        async rpc(method, fields = {}) {
          const id = ++nextId;
          const reply = receive(port, value => value.id === id);
          port.postMessage({ version: 1, session: message.session, id, method, ...fields });
          return reply;
        },
      };
      clients.push(client);
      offers.push(client);
    } };
    return { source, offers };
  }
  function discover(source = viewer()) { owner.probe(source.source, { origin: viewerOrigin }); return source.offers.at(-1); }
  t.after(() => { dispose(); for (const client of clients) client.port.close(); });
  return { owner, viewer, discover, dispose, fetches };
}
const call = (client, name, args = [], file = FILE) => client.rpc('call', { binding: { file, function: name }, args });

beforeEach(() => { setFaultInjection(false); reset(); });

test('registration is opt-in and accepts only a permitted sibling under an Edit parent', t => {
  for (const options of [{ search: '' }, { referrer: '' }, { referrer: 'https://unrelated.example/' }]) {
    const host = mount(t, options);
    const viewer = host.viewer();
    host.owner.probe(viewer.source);
    assert.equal(viewer.offers.length, 0);
  }
  const host = mount(t);
  const viewer = host.viewer();
  host.owner.probe(viewer.source, { origin: 'https://unrelated.example' });
  host.owner.probe({ ...viewer.source, parent: {} });
  assert.equal(viewer.offers.length, 0);
  host.owner.probe(viewer.source);
  assert.equal(viewer.offers.length, 1);
  assert.deepEqual(viewer.offers[0].message.modules, [{ file: FILE, functions: Object.keys(actualFunctions) }]);
  assert.equal(Object.hasOwn(viewer.offers[0].message, 'model'), false);
});

test('explicit developer opt-in survives an unflagged Edit preview reopen but requires a new claim', async t => {
  const first = mount(t, { search: '', enabled: true });
  const original = first.discover();
  assert.ok(original);
  await original.rpc('claim');
  await call(original, 'addTask');
  first.dispose();

  const reopened = mount(t, { search: '', enabled: true }).discover();
  assert.ok(reopened);
  assert.match((await call(reopened, 'reset')).error.message, /Claim this app/);
  assert.deepEqual((await reopened.rpc('claim')).result, { claimed: true });
  assert.deepEqual((await call(reopened, 'reset')).result, { status: 'absent' });
});

test('explicit opt-in preserves standalone, Edit-parent, and peer boundaries', t => {
  for (const options of [{ unframed: true }, { referrer: '' }, { referrer: 'https://unrelated.example/' }]) {
    const host = mount(t, { search: '', enabled: true, ...options });
    const viewer = host.viewer();
    host.owner.probe(viewer.source);
    assert.equal(viewer.offers.length, 0);
  }
  const enabled = mount(t, { search: '', enabled: true });
  const viewer = enabled.viewer();
  enabled.owner.probe(viewer.source, { origin: 'https://unrelated.example' });
  enabled.owner.probe({ ...viewer.source, parent: {} });
  assert.equal(viewer.offers.length, 0);
});

test('the generic SDK retains its default query opt-in and validates explicit enablement', t => {
  const disabled = mount(t, { search: '' });
  assert.equal(disabled.discover(), undefined);
  const queryEnabled = mount(t, { enabled: false });
  assert.ok(queryEnabled.discover());
  for (const enabled of [1, 'true', null]) assert.throws(() => mount(t, { enabled }), /must be a boolean/);
});

test('only a claimed connection calls the same functions as the ordinary application', async t => {
  const host = mount(t);
  const client = host.discover();
  assert.deepEqual((await client.rpc('ping')).result, { alive: true, claimed: false });
  assert.match((await call(client, 'addTask')).error.message, /Claim this app/);
  assert.deepEqual((await client.rpc('source', { file: FILE })).result, { file: FILE, content: '// Registered source' });
  assert.deepEqual(observe(), { status: 'absent' });
  assert.deepEqual((await client.rpc('claim')).result, { claimed: true });
  assert.deepEqual((await call(client, 'addTask')).result, { status: 'open' });
  assert.deepEqual(observe(), { status: 'open' });
  setFaultInjection(true);
  assert.deepEqual((await call(client, 'completeTask')).result, { status: 'open' });
  assert.deepEqual((await call(client, 'observe')).result, { status: 'open' });
});

test('unknown file/export, excess arguments, and stale sessions cannot invoke code', async t => {
  const client = mount(t).discover();
  await client.rpc('claim');
  assert.match((await call(client, 'addTask', [], '../task-app.js')).error.message, /not registered/);
  assert.match((await call(client, 'constructor')).error.message, /not registered/);
  assert.match((await call(client, 'addTask', Array(33).fill(null))).error.message, /at most 32/);
  assert.match((await client.rpc('source', { file: '../secret' })).error.message, /not registered/);
  assert.match((await client.rpc('call', { session: 'stale-session', binding: { file: FILE, function: 'addTask' }, args: [] })).error.message, /stale/);
  assert.deepEqual(observe(), { status: 'absent' });
});

test('discovery never steals an active owner and ownership can be released explicitly', async t => {
  const host = mount(t);
  const original = host.discover();
  await original.rpc('claim');
  const candidate = host.discover();
  assert.equal(candidate.message.instance, original.message.instance);
  assert.notEqual(candidate.message.session, original.message.session);
  assert.match((await candidate.rpc('claim')).error.message, /already claimed/);
  assert.match((await call(candidate, 'addTask')).error.message, /Claim this app/);
  assert.deepEqual((await call(original, 'addTask')).result, { status: 'open' });
  assert.deepEqual((await original.rpc('release')).result, { released: true });
  assert.deepEqual((await candidate.rpc('claim')).result, { claimed: true });
  assert.deepEqual((await call(candidate, 'observe')).result, { status: 'open' });
});

test('source reads are limited to registered same-origin application files', async t => {
  const host = mount(t);
  const client = host.discover();
  await client.rpc('claim');
  assert.deepEqual((await client.rpc('source', { file: FILE })).result, { file: FILE, content: '// Registered source' });
  assert.equal(host.fetches.length, 1);
  assert.equal(host.fetches[0].url, 'https://project.preview.example/__edit_file__/app/src/task-app.js');
  assert.equal(host.fetches[0].options.cache, 'no-store');
  const large = mount(t, { fetch: async () => ({ ok: true, text: async () => 'x'.repeat(1024 * 1024 + 1) }) }).discover();
  await large.rpc('claim');
  assert.match((await large.rpc('source', { file: FILE })).error.message, /1 MiB/);
});

test('release immediately retires queued calls and keeps ping responsive during a running call', async t => {
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const host = mount(t, { functions: {
    async first() { calls.push('first'); began(); await gate; return 'finished'; },
    second() { calls.push('second'); },
  } });
  const client = host.discover();
  await client.rpc('claim');
  client.port.postMessage({ version: 1, session: client.message.session, id: 20, method: 'call', binding: { file: FILE, function: 'first' }, args: [] });
  await started;
  client.port.postMessage({ version: 1, session: client.message.session, id: 21, method: 'call', binding: { file: FILE, function: 'second' }, args: [] });
  assert.deepEqual((await client.rpc('ping')).result, { alive: true, claimed: true });
  assert.deepEqual((await client.rpc('release')).result, { released: true });
  const candidate = host.discover();
  assert.match((await candidate.rpc('claim')).error.message, /previous call/);
  release();
  await tick();
  await tick();
  assert.deepEqual(calls, ['first']);
  assert.deepEqual((await candidate.rpc('claim')).result, { claimed: true });
});

test('pagehide closes active ports and prevents later discovery', async t => {
  const host = mount(t);
  const client = host.discover();
  await client.rpc('claim');
  const notice = receive(client.port, value => value.type === 'edit-app-bridge:disconnected');
  host.owner.dispatchEvent(new Event('pagehide'));
  assert.match((await notice).reason, /closed or reloaded/);
  const viewer = host.viewer();
  host.owner.probe(viewer.source);
  assert.equal(viewer.offers.length, 0);
});

test('pending discovery offers are bounded without closing the active owner', async t => {
  const host = mount(t);
  const owner = host.discover();
  await owner.rpc('claim');
  const oldest = host.discover();
  const notice = receive(oldest.port, value => value.type === 'edit-app-bridge:disconnected');
  for (let n = 0; n < 8; n++) host.discover();
  assert.match((await notice).reason, /superseded/);
  assert.deepEqual((await owner.rpc('ping')).result, { alive: true, claimed: true });
});

test('repeated discovery probes preserve the first channel while a new nonce offers a fresh session', async t => {
  const host = mount(t);
  const viewer = host.viewer();
  host.owner.probe(viewer.source);
  const original = viewer.offers[0];
  for (let n = 0; n < 12; n++) host.owner.probe(viewer.source);
  assert.equal(viewer.offers.length, 1);
  assert.deepEqual((await original.rpc('claim')).result, { claimed: true });
  host.owner.probe(viewer.source);
  assert.equal(viewer.offers.length, 1);

  host.owner.probe(viewer.source, { data: { type: 'edit-app-bridge:probe', version: 1, nonce: 'new-discovery-nonce' } });
  assert.equal(viewer.offers.length, 2);
  const fresh = viewer.offers[1];
  assert.notEqual(fresh.message.session, original.message.session);
  assert.equal(fresh.message.instance, original.message.instance);
  assert.match((await fresh.rpc('claim')).error.message, /already claimed/);
  assert.deepEqual((await call(original, 'addTask')).result, { status: 'open' });
  assert.deepEqual((await original.rpc('ping')).result, { alive: true, claimed: true });
});

test('an explicitly configured second-server origin is allowed without a preview-domain wildcard', t => {
  const peer = 'https://listener-specific.edit-test.foo';
  const host = mount(t, { viewerOrigin: peer });
  const viewer = host.viewer();
  host.owner.probe(viewer.source, { origin: 'https://listener-other.edit-test.foo' });
  host.owner.probe(viewer.source, { origin: VIEWER });
  assert.equal(viewer.offers.length, 0);
  host.owner.probe(viewer.source, { origin: peer });
  assert.equal(viewer.offers.length, 1);
});
