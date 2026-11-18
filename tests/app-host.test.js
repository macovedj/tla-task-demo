import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { installParentAppHost } from '../src/app-host.js';
import { taskDemo } from '../src/adapter.js';
import { observe, reset, setFaultInjection } from '../src/task-app.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const bindings = {
  actions: {
    Add: { file: 'src/task-app.js', function: 'addTask' },
    Complete: { file: 'src/task-app.js', function: 'completeTask' },
    Reopen: { file: 'src/task-app.js', function: 'reopenTask' },
    Delete: { file: 'src/task-app.js', function: 'deleteTask' },
  },
  observe: { file: 'src/task-app.js', function: 'observe' },
  reset: { file: 'src/task-app.js', function: 'reset' },
};
const request = (id, method, action) => ({ version: 1, id, method, ...(action === undefined ? {} : { action }), binding: method === 'perform' ? (Object.hasOwn(bindings.actions, action) ? bindings.actions[action] : undefined) : (Object.hasOwn(bindings, method) ? bindings[method] : undefined) });

class FakeWindow extends EventTarget {
  constructor(search = '?bridge=parent') {
    super();
    this.location = { origin: 'https://preview.example', search };
    this.messages = [];
    this.parent = { postMessage: (message, origin) => this.messages.push({ message, origin }) };
  }
  deliver(data, ports = [], overrides = {}) {
    const event = new Event('message');
    Object.assign(event, { data, ports, origin: this.location.origin, source: this.parent, ...overrides });
    this.dispatchEvent(event);
  }
}
function message(port, predicate = value => Object.hasOwn(value, 'id')) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port.removeEventListener('message', receive); reject(new Error('No app reply.')); }, 1000);
    function receive(event) {
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      port.removeEventListener('message', receive);
      resolve(event.data);
    }
    port.addEventListener('message', receive);
    port.start();
  });
}
function mount(t, adapter = taskDemo, options = {}) {
  const owner = new FakeWindow(options.search);
  if (options.unframed) owner.parent = owner;
  const dispose = installParentAppHost(adapter, { window: owner });
  const channels = [];
  function connect(session = 'session-1', overrides) {
    const channel = new MessageChannel();
    channels.push(channel);
    channel.port2.start();
    owner.deliver({ type: 'tla-app-connect', version: 1, session }, [channel.port1], overrides);
    return channel.port2;
  }
  t.after(() => { dispose(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } });
  return { owner, connect, dispose };
}
async function rpc(port, id, method, action) {
  const response = message(port, value => value.id === id);
  port.postMessage(request(id, method, action));
  return response;
}

beforeEach(() => { setFaultInjection(false); reset(); });

test('parent bridge is opt-in and announces only to the same-origin parent', t => {
  const disabled = mount(t, taskDemo, { search: '' });
  assert.deepEqual(disabled.owner.messages, []);
  const unframed = mount(t, taskDemo, { unframed: true });
  assert.deepEqual(unframed.owner.messages, []);
  const enabled = mount(t);
  assert.deepEqual(enabled.owner.messages, [{ message: { type: 'tla-app-ready', version: 1 }, origin: 'https://preview.example' }]);
  enabled.owner.deliver({ type: 'tla-app-probe', version: 1 });
  assert.equal(enabled.owner.messages.length, 2);
});

test('RPC drives the existing application singleton and exposes the injected fault', async t => {
  const host = mount(t);
  const port = host.connect();
  assert.deepEqual(await rpc(port, 1, 'perform', 'Add'), { version: 1, id: 1, result: { status: 'open' } });
  assert.deepEqual(observe(), { status: 'open' });
  setFaultInjection(true);
  assert.deepEqual(await rpc(port, 2, 'perform', 'Complete'), { version: 1, id: 2, result: { status: 'open' } });
  assert.deepEqual(await rpc(port, 3, 'reset'), { version: 1, id: 3, result: { status: 'absent' } });
  assert.deepEqual(await rpc(port, 4, 'observe'), { version: 1, id: 4, result: { status: 'absent' } });
});

test('only the actual same-origin parent may transfer a connection', async t => {
  const host = mount(t);
  const wrongOrigin = host.connect('bad-origin', { origin: 'https://unrelated.example' });
  const wrongSource = host.connect('bad-source', { source: {} });
  wrongOrigin.postMessage({ version: 1, id: 1, method: 'perform', action: 'Add' });
  wrongSource.postMessage({ version: 1, id: 2, method: 'perform', action: 'Add' });
  await tick();
  assert.deepEqual(observe(), { status: 'absent' });
  assert.deepEqual((await rpc(host.connect('trusted'), 3, 'observe')).result, { status: 'absent' });
});

test('unknown actions, unsupported requests, and disabled operations cannot invent app state', async t => {
  const port = mount(t).connect();
  assert.match((await rpc(port, 1, 'perform', 'constructor')).error.message, /Unknown app action/);
  assert.match((await rpc(port, 2, 'evaluate', 'Add')).error.message, /Unsupported/);
  const reply = message(port, value => value.id === 3);
  port.postMessage({ version: 1, id: 3, method: 'perform', action: 'Add', source: 'status = "done"' });
  assert.match((await reply).error.message, /Unsupported/);
  assert.match((await rpc(port, 4, 'perform', 'Complete')).error.message, /disabled/);
  const mismatched = message(port, value => value.id === 5);
  port.postMessage({ ...request(5, 'perform', 'Add'), binding: bindings.actions.Delete });
  assert.match((await mismatched).error.message, /source binding does not match/);
  const missing = message(port, value => value.id === 6);
  port.postMessage({ version: 1, id: 6, method: 'reset' });
  assert.match((await missing).error.message, /source binding does not match/);
  assert.deepEqual(observe(), { status: 'absent' });
});

test('operations serialize and replies use a fresh observation rather than a handler return', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let status = 'absent';
  const calls = [];
  const adapter = {
    bindings,
    actions: ['Add'],
    async perform() { calls.push('Add'); await gate; status = 'open'; return { status: 'done' }; },
    reset() { calls.push('Reset'); status = 'absent'; return { status: 'done' }; },
    observe() { calls.push('Observe'); return { status }; },
  };
  const port = mount(t, adapter).connect();
  const first = rpc(port, 1, 'perform', 'Add');
  const second = rpc(port, 2, 'reset');
  await tick();
  await tick();
  assert.deepEqual(calls, ['Add']);
  release();
  assert.deepEqual((await first).result, { status: 'open' });
  assert.deepEqual((await second).result, { status: 'absent' });
  assert.deepEqual(calls, ['Add', 'Observe', 'Reset', 'Observe']);
});

test('disconnect drops queued operations and permits a new explicit session', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const adapter = {
    bindings,
    actions: ['Add', 'Delete'],
    async perform(action) { calls.push(action); if (action === 'Add') await gate; },
    observe: () => ({ status: 'open' }),
    reset() {},
  };
  const host = mount(t, adapter);
  const port = host.connect();
  const notice = message(port, value => value.type === 'tla-app-disconnected');
  port.postMessage(request(1, 'perform', 'Add'));
  port.postMessage(request(2, 'perform', 'Delete'));
  await tick();
  await tick();
  host.owner.deliver({ type: 'tla-app-disconnect', version: 1, session: 'session-1' });
  assert.equal((await notice).session, 'session-1');
  release();
  await tick();
  assert.deepEqual(calls, ['Add']);
  assert.deepEqual((await rpc(host.connect('session-2'), 3, 'observe')).result, { status: 'open' });
});

test('queue admission is bounded and pagehide retires the connection', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { bindings, actions: ['Add'], perform: () => gate, observe: () => ({ status: 'open' }), reset() {} };
  const host = mount(t, adapter);
  const port = host.connect();
  const overflow = message(port, value => value.id === 32);
  for (let id = 0; id <= 32; id++) port.postMessage(request(id, 'perform', 'Add'));
  assert.match((await overflow).error.message, /queue is full/);
  const notice = message(port, value => value.type === 'tla-app-disconnected');
  host.owner.dispatchEvent(new Event('pagehide'));
  assert.match((await notice).reason, /closed or reloaded/);
  const announcements = host.owner.messages.length;
  host.owner.deliver({ type: 'tla-app-probe', version: 1 });
  assert.equal(host.owner.messages.length, announcements);
  release();
});

test('unexpected observed fields are rejected rather than hidden from the checker', async t => {
  const adapter = { bindings, actions: ['Add'], perform() {}, reset() {}, observe: () => ({ status: 'open', extra: true }) };
  const port = mount(t, adapter).connect();
  assert.match((await rpc(port, 1, 'observe')).error.message, /invalid observation/);
});
