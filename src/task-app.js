// This is the application under test. It has no dependency on the model or runner.
let status = 'absent';
let faultInjection = false;
const subscribers = new Set();

export function observe() {
  return { status };
}

function notify() {
  for (const subscriber of [...subscribers]) subscriber(observe());
}

function transition(action, allowed, next) {
  if (!allowed.includes(status)) {
    throw new Error(`${action} is disabled while task status is '${status}'.`);
  }
  status = next;
  notify();
  return observe();
}

export function addTask() {
  return transition('Add', ['absent'], 'open');
}

export function completeTask() {
  // Deliberate application bug, controlled by the demonstration harness.
  return transition('Complete', ['open'], faultInjection ? 'open' : 'done');
}

export function reopenTask() {
  return transition('Reopen', ['done'], 'open');
}

export function deleteTask() {
  return transition('Delete', ['open', 'done'], 'absent');
}

export function reset() {
  status = 'absent';
  notify();
  return observe();
}

export function enabledActions() {
  if (status === 'absent') return ['Add'];
  if (status === 'open') return ['Complete', 'Delete'];
  return ['Reopen', 'Delete'];
}

export function subscribe(subscriber) {
  if (typeof subscriber !== 'function') throw new TypeError('Subscriber must be a function.');
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function setFaultInjection(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Fault injection must be a boolean.');
  if (faultInjection === enabled) return;
  faultInjection = enabled;
  notify();
}

export function isFaultInjectionEnabled() {
  return faultInjection;
}
