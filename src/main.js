import { observe, enabledActions, subscribe, setFaultInjection, isFaultInjectionEnabled } from './task-app.js';
import { taskDemo } from './adapter.js';
import { installParentAppHost } from './app-host.js';

// The console and optional lab bridge share this live application instance.
Object.defineProperty(window, 'tlaTaskDemo', { value: taskDemo });
if (new URLSearchParams(location.search).get('bridge') === 'parent') installParentAppHost(taskDemo);

const $ = id => document.getElementById(id);
const buttons = [...document.querySelectorAll('[data-action]')];

function render() {
  const state = observe();
  const present = state.status !== 'absent';
  $('empty-state').hidden = present;
  $('task').hidden = !present;
  $('task').classList.toggle('done', state.status === 'done');
  $('task-indicator').textContent = state.status === 'done' ? '✓' : '';
  $('task-description').textContent = state.status === 'done' ? 'Done. You can reopen it or clear the slate.' : 'Ready when you are.';
  $('observed-state').textContent = JSON.stringify(state, null, 2);
  document.querySelectorAll('[data-status]').forEach(item => {
    const active = item.dataset.status === state.status;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
  const allowed = enabledActions();
  buttons.forEach(button => { button.disabled = !allowed.includes(button.dataset.action); });
  $('fault-toggle').checked = isFaultInjectionEnabled();
  document.body.classList.toggle('fault-enabled', isFaultInjectionEnabled());
  $('feedback').textContent = state.status === 'absent' ? 'Choose Add to create the task.' : state.status === 'open' ? 'The task is open. Complete it or delete it.' : 'The task is done. Reopen it or delete it.';
}

function run(operation) {
  $('action-error').hidden = true;
  try { operation(); }
  catch (error) { $('action-error').textContent = error.message; $('action-error').hidden = false; }
}

buttons.forEach(button => button.addEventListener('click', () => run(() => taskDemo.perform(button.dataset.action))));
$('reset').addEventListener('click', () => run(() => taskDemo.reset()));
$('fault-toggle').addEventListener('change', event => run(() => setFaultInjection(event.target.checked)));
subscribe(render);
render();
