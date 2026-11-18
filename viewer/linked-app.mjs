import { connectParentApp } from './app-bridge.mjs';
import { createAppConformance, validateAppManifest } from './lib/app-conformance.mjs';
import { prepareBrowserRequest } from './lib/browser-engine.mjs';
import { renderTraceSimulator } from './trace-simulator.mjs';
import { onAnalyzerState, startBrowserTrace, nextBrowserTrace, cancelBrowserAnalysis } from './engine-client.mjs';

const $ = id => document.getElementById(id);
let connection = null, conformance = null, inputs = null, session = null;
let currentStep = 0, busy = false, error = null, generation = 0, connected = false;
const checkPanel = document.querySelector('.check-panel');

function expectedJson(state) {
  if (!state?.variables) return null;
  return Object.fromEntries(Object.entries(state.variables).map(([name, value]) => {
    try { return [name, JSON.parse(value)]; } catch { return [name, value]; }
  }));
}
function showCheck(title, message, expected = null, observed = null, verdict = '') {
  $('check-heading').textContent = title;
  $('check-message').textContent = message;
  $('expected-state').textContent = expected === null ? '—' : JSON.stringify(expected, null, 2);
  $('observed-state').textContent = observed === null ? '—' : JSON.stringify(observed, null, 2);
  checkPanel.dataset.verdict = verdict;
}
function sourceUrl(binding) {
  if (!binding || !connection?.editProjectUrl) return null;
  try {
    const url = new URL(connection.editProjectUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'edit-test.dev' || !/^\/p\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.username || url.password || url.port) return null;
    const original = url.searchParams.get('file') || '';
    // The supplied model/editor link identifies this checkout's path in Edit.
    const modelPath = connection.manifest.model.module;
    const prefix = original.endsWith(modelPath) ? original.slice(0, -modelPath.length) : 'code/tla-task-demo/';
    url.search = '';
    url.hash = '';
    url.searchParams.set('file', prefix + binding.file);
    return url.href;
  } catch { return null; }
}
function bindingElement(binding, action) {
  const url = sourceUrl(binding);
  const element = document.createElement(url ? 'a' : 'code');
  element.textContent = `${action ? action + ' → ' : ''}${binding.file} → ${binding.function}()`;
  if (url) { element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
  return element;
}
function showBinding(action) {
  $('last-binding').replaceChildren();
  const binding = action ? connection?.manifest.actions[action] : connection?.manifest.reset;
  if (binding) $('last-binding').append(bindingElement(binding, action || 'Init / reset'));
}
function render() {
  const canRun = connected && Boolean(inputs);
  const needsRecovery = Boolean(session?.steps.length && !conformance?.synchronized);
  const visibleSession = session ? { ...session, available: needsRecovery ? [] : session.available } : null;
  renderTraceSimulator($('linked-trace'), {
    session: visibleSession, rootModule: inputs?.rootModule, currentStep,
    canStart: canRun, busy, dirty: false, error,
    onStart: start, onRestart: start, onChooseInitial: chooseInitial,
    onChooseTransition: chooseTransition, onSelectStep: selectStep,
    onCancel: cancel, onOpenConfig() { $('model-details').open = true; $('model-details').scrollIntoView({ block: 'nearest' }); },
  });
  if (needsRecovery) {
    const empty = $('linked-trace').querySelector('.sim-empty');
    if (empty) empty.textContent = connected ? 'Restore the app with Reset & replay here before continuing.' : 'Reload connection in the lab to reconnect both panes.';
  }
  $('recover-app').disabled = !canRun || busy || !session?.steps.length;
}
function ensureCurrent(operation) {
  if (generation !== operation || !connected) {
    const stale = new Error('The linked operation was cancelled or disconnected.');
    stale.code = 'LINK_CANCELLED';
    throw stale;
  }
}
function failure(cause, expectedState = session?.steps[currentStep]?.state) {
  error = cause.message || 'The application could not complete the action.';
  if (cause.code === 'LINK_CANCELLED') return;
  showCheck(cause.code === 'APP_STATE_MISMATCH' ? 'Application differs from the model' : 'Application needs recovery', error,
    cause.expected || expectedJson(expectedState), cause.observed || conformance?.lastObservation || null, 'fail');
}
async function availableAt(state, operation) {
  const result = await nextBrowserTrace({ ...inputs, state: state.typedState });
  ensureCurrent(operation);
  if (result.fromKey !== state.key) throw new Error('The engine returned actions for a different state.');
  return result;
}
function commitAvailable(result) {
  session.available = result.transitions;
  session.actionDiagnostics = result.actionDiagnostics || [];
  session.actionDiagnosticsTruncated = Boolean(result.actionDiagnosticsTruncated);
  session.warnings = [...new Set([...session.warnings, ...(result.warnings || [])])];
}
async function start() {
  if (busy || !connected || !inputs) return;
  const operation = ++generation;
  busy = true; error = null; conformance.invalidate(); render();
  try {
    const result = await startBrowserTrace(inputs);
    ensureCurrent(operation);
    const nextSession = { rootModule: inputs.rootModule, initialStates: result.states, steps: [], available: [], warnings: result.warnings || [] };
    if (result.states.length === 1) {
      const state = result.states[0];
      const actual = await conformance.reset(state);
      ensureCurrent(operation);
      session = nextSession; currentStep = 0;
      session.steps = [{ action: null, state }];
      showBinding(null);
      showCheck('Init matches', 'The application was reset and its observed state matches Init.', expectedJson(state), actual, 'pass');
      commitAvailable(await availableAt(state, operation));
    } else {
      session = nextSession; currentStep = 0;
      showCheck('Choose an initial state', 'The linked reset function must produce the selected initial state.');
    }
  } catch (cause) { if (generation === operation) failure(cause); }
  finally { if (generation === operation) { busy = false; render(); } }
}
async function chooseInitial(index) {
  const state = session?.initialStates[index];
  if (busy || !connected || !state) return;
  const operation = ++generation; busy = true; error = null; render();
  try {
    const actual = await conformance.reset(state);
    ensureCurrent(operation);
    session.steps = [{ action: null, state }]; currentStep = 0; session.available = []; session.actionDiagnostics = [];
    showBinding(null); showCheck('Init matches', 'Reset produced the selected initial state.', expectedJson(state), actual, 'pass');
    commitAvailable(await availableAt(state, operation));
  } catch (cause) { if (generation === operation) failure(cause, state); }
  finally { if (generation === operation) { busy = false; render(); } }
}
async function chooseTransition(index) {
  const outcome = session?.available[index], from = session?.steps[currentStep]?.state;
  if (busy || !connected || !outcome || !from || !conformance.synchronized) return;
  const operation = ++generation; busy = true; error = null; showBinding(outcome.action); render();
  try {
    // The app receives the action ID and source binding. Expected states stay here.
    const actual = await conformance.perform(outcome.action, from, outcome.to);
    ensureCurrent(operation);
    // Commit only after independent observation matches the chosen successor.
    session.steps = [...session.steps.slice(0, currentStep + 1), { action: outcome.action, state: outcome.to }];
    currentStep = session.steps.length - 1;
    session.available = [];
    showCheck(`${outcome.action} matches`, 'The exported function ran in the preview and its observed result matches the model.', expectedJson(outcome.to), actual, 'pass');
    const choices = await availableAt(outcome.to, operation);
    commitAvailable(choices);
  } catch (cause) { if (generation === operation) failure(cause, outcome.to); }
  finally { if (generation === operation) { busy = false; render(); } }
}
async function selectStep(index) {
  if (busy || !connected || !Number.isInteger(index) || !session?.steps[index]) return;
  const operation = ++generation; busy = true; error = null; render();
  try {
    const actual = await conformance.replay(session.steps, index);
    ensureCurrent(operation);
    const state = session.steps[index].state;
    currentStep = index; session.available = []; session.actionDiagnostics = []; showBinding(session.steps[index].action);
    showCheck('Replay matches', `Reset and replay restored the application to step ${index}. Choose another action to branch.`, expectedJson(state), actual, 'pass');
    commitAvailable(await availableAt(state, operation));
  } catch (cause) { if (generation === operation) failure(cause, session.steps[index].state); }
  finally { if (generation === operation) { busy = false; render(); } }
}
function cancel() {
  ++generation; busy = false; conformance?.invalidate(); cancelBrowserAnalysis();
  error = 'Operation cancelled. Reset & replay here before continuing.';
  showCheck('Application needs recovery', error, expectedJson(session?.steps[currentStep]?.state), conformance?.lastObservation || null, 'fail');
  render();
}
function renderSources() {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Model action', 'Application source']) { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); }
  const body = table.createTBody();
  for (const [action, binding] of Object.entries(connection.manifest.actions)) {
    const row = body.insertRow(); row.insertCell().textContent = action; row.insertCell().append(bindingElement(binding));
  }
  $('binding-list').replaceChildren(table);
  $('model-files').replaceChildren();
  for (const file of inputs.files) {
    const detail = document.createElement('details'); detail.className = 'source-file';
    const summary = document.createElement('summary'); summary.textContent = file.name;
    const pre = document.createElement('pre'); pre.textContent = file.content;
    detail.append(summary, pre); $('model-files').append(detail);
  }
}
$('recover-app').addEventListener('click', () => selectStep(currentStep));
onAnalyzerState(state => { $('engine-status').textContent = state.status === 'ready' ? 'WASM ready · browser local' : state.message; });
render();

try {
  connection = await connectParentApp();
  connection.manifest = validateAppManifest(connection.manifest);
  const moduleName = connection.manifest.model.module.split('/').at(-1);
  const configName = connection.manifest.model.config.split('/').at(-1);
  inputs = { files: connection.files, rootModule: moduleName, configFile: configName, limits: { maxStates: 1000, maxDepth: 100 } };
  prepareBrowserRequest(inputs);
  conformance = createAppConformance(connection.client, connection.manifest);
  connected = true;
  $('connection-status').textContent = 'Application connected';
  connection.client.onDisconnect(reason => {
    connected = false; ++generation; busy = false; conformance.invalidate(); cancelBrowserAnalysis();
    error = typeof reason === 'string' ? reason : reason?.message || 'The application connection closed. Reload the lab to reconnect.';
    $('connection-status').textContent = 'Disconnected';
    showCheck('Application disconnected', error, expectedJson(session?.steps[currentStep]?.state), conformance.lastObservation, 'fail');
    render();
  });
  if (!connected) throw new Error('The application disconnected during setup. Reload the lab to reconnect.');
  renderSources();
  showCheck('Ready to check Init', 'Start from Init to reset the running app and compare its state with the model.');
  render();
  // Opening the dedicated linked lab is the explicit request to start this model.
  await start();
} catch (cause) {
  connected = false; connection?.client.close();
  $('connection-status').textContent = 'Not connected'; error = cause.message;
  showCheck('Could not connect', cause.message, null, null, 'fail'); render();
}
window.addEventListener('pagehide', () => { ++generation; conformance?.invalidate(); connection?.client.close(); cancelBrowserAnalysis(); }, { once: true });
