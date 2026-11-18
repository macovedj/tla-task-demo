import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTask, completeTask, reopenTask, deleteTask, observe, reset,
  enabledActions, subscribe, setFaultInjection, isFaultInjectionEnabled,
} from '../src/task-app.js';

beforeEach(() => {
  setFaultInjection(false);
  reset();
});

test('task transitions cover both delete paths and repeated cycles', () => {
  assert.deepEqual(observe(), { status: 'absent' });
  assert.deepEqual(enabledActions(), ['Add']);
  assert.deepEqual(addTask(), { status: 'open' });
  assert.deepEqual(enabledActions(), ['Complete', 'Delete']);
  assert.deepEqual(completeTask(), { status: 'done' });
  assert.deepEqual(enabledActions(), ['Reopen', 'Delete']);
  assert.deepEqual(reopenTask(), { status: 'open' });
  assert.deepEqual(deleteTask(), { status: 'absent' });
  addTask();
  completeTask();
  assert.deepEqual(deleteTask(), { status: 'absent' });
  assert.deepEqual(addTask(), { status: 'open' });
});

test('disabled actions throw without changing state or notifying', () => {
  const changes = [];
  const unsubscribe = subscribe(snapshot => changes.push(snapshot));
  try {
    for (const action of [completeTask, reopenTask, deleteTask]) {
      assert.throws(action, /is disabled while task status is 'absent'/);
    }
    assert.deepEqual(changes, []);
    addTask();
    for (const action of [addTask, reopenTask]) {
      assert.throws(action, /is disabled while task status is 'open'/);
    }
    assert.deepEqual(observe(), { status: 'open' });
    completeTask();
    for (const action of [addTask, completeTask]) {
      assert.throws(action, /is disabled while task status is 'done'/);
    }
    assert.deepEqual(observe(), { status: 'done' });
    assert.deepEqual(changes, [{ status: 'open' }, { status: 'done' }]);
  } finally {
    unsubscribe();
  }
});

test('observations, returned states, and action lists do not expose application state', () => {
  const first = observe();
  const second = observe();
  assert.notEqual(first, second);
  first.status = 'done';
  const actions = enabledActions();
  actions.push('Complete');
  assert.deepEqual(observe(), { status: 'absent' });
  assert.deepEqual(enabledActions(), ['Add']);
  const result = addTask();
  result.status = 'absent';
  assert.deepEqual(observe(), { status: 'open' });
});

test('reset and prefix replay restore the concrete app before taking another branch', () => {
  const prefix = [addTask];
  prefix.forEach(action => action());
  completeTask();
  assert.deepEqual(observe(), { status: 'done' });
  assert.deepEqual(reset(), { status: 'absent' });
  prefix.forEach(action => action());
  assert.deepEqual(observe(), { status: 'open' });
  deleteTask();
  assert.deepEqual(observe(), { status: 'absent' });
});

test('fault injection leaves Complete observably wrong and survives reset', () => {
  const changes = [];
  const unsubscribe = subscribe(snapshot => changes.push(snapshot));
  try {
    setFaultInjection(true);
    assert.equal(isFaultInjectionEnabled(), true);
    addTask();
    assert.deepEqual(completeTask(), { status: 'open' });
    assert.deepEqual(enabledActions(), ['Complete', 'Delete']);
    assert.deepEqual(changes, [{ status: 'absent' }, { status: 'open' }, { status: 'open' }]);
    reset();
    assert.equal(isFaultInjectionEnabled(), true);
    addTask();
    assert.deepEqual(completeTask(), { status: 'open' });
    setFaultInjection(false);
    assert.deepEqual(completeTask(), { status: 'done' });
  } finally {
    unsubscribe();
  }
});

test('subscribers receive isolated snapshots and unsubscribe independently', () => {
  const snapshots = [];
  const unsubscribeMutator = subscribe(snapshot => { snapshot.status = 'corrupted'; });
  const unsubscribeObserver = subscribe(snapshot => snapshots.push(snapshot));
  try {
    addTask();
    completeTask();
    assert.deepEqual(snapshots, [{ status: 'open' }, { status: 'done' }]);
    assert.notEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(observe(), { status: 'done' });
    unsubscribeObserver();
    unsubscribeObserver();
    reset();
    assert.equal(snapshots.length, 2);
    assert.deepEqual(observe(), { status: 'absent' });
  } finally {
    unsubscribeMutator();
    unsubscribeObserver();
  }
});

test('configuration and subscriber arguments are validated', () => {
  assert.throws(() => subscribe(null), /Subscriber must be a function/);
  assert.throws(() => setFaultInjection('true'), /Fault injection must be a boolean/);
  assert.equal(isFaultInjectionEnabled(), false);
  assert.deepEqual(observe(), { status: 'absent' });
});
