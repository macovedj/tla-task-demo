import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as app from '../src/task-app.js';
import { taskDemo } from '../src/adapter.js';

beforeEach(() => { app.setFaultInjection(false); app.reset(); });

test('manifest resolves to the actual exported functions used by the live adapter', async () => {
  const manifest = JSON.parse(await readFile(new URL('../tla-bindings.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.actions), taskDemo.actions);
  for (const [action, binding] of Object.entries(manifest.actions)) {
    assert.equal(binding.file, 'src/task-app.js');
    assert.equal(typeof app[binding.function], 'function', action);
  }
  assert.equal(app[manifest.observe.function], taskDemo.observe);
  assert.equal(app[manifest.reset.function], taskDemo.reset);
  taskDemo.perform('Add');
  assert.deepEqual(app.observe(), { status: 'open' }, 'adapter and application share state');
  taskDemo.perform('Complete');
  assert.deepEqual(app.observe(), { status: 'done' });
});

test('reset and prefix replay can take another branch without stale application state', () => {
  taskDemo.perform('Add');
  taskDemo.perform('Complete');
  taskDemo.reset();
  taskDemo.perform('Add');
  taskDemo.perform('Delete');
  assert.deepEqual(taskDemo.observe(), { status: 'absent' });
});

test('dispatcher rejects unregistered and inherited names without invoking them', () => {
  for (const action of ['Unknown', 'toString', '__proto__', 'reset']) {
    assert.throws(() => taskDemo.perform(action), /Unknown task action/);
  }
  assert.deepEqual(taskDemo.observe(), { status: 'absent' });
});

test('faulty Complete reports the actual unchanged state instead of the model expectation', () => {
  app.setFaultInjection(true);
  taskDemo.perform('Add');
  const result = taskDemo.perform('Complete');
  assert.deepEqual(result, { status: 'open' });
  assert.deepEqual(taskDemo.observe(), { status: 'open' });
});
