/** Check a running application's observations against locally evaluated states. */
export class AppConformanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppConformanceError';
    this.code = code;
    Object.assign(this, details);
  }
}

const own = (object, name) => Object.hasOwn(object, name);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message, details) => { throw new AppConformanceError(code, message, details); };
const copy = value => Object.fromEntries(Object.entries(value));

function sourceBinding(value, label) {
  if (!record(value) || typeof value.file !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(value.file) || value.file.startsWith('/') || value.file.split('/').some(part => !part || part === '.' || part === '..') || typeof value.function !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value.function)) {
    fail('APP_MANIFEST_INVALID', label + ' needs a relative source file and exported function.');
  }
  return {file:value.file, function:value.function};
}

export function validateAppManifest(value) {
  if (!record(value) || value.version !== 1 || !record(value.model) || typeof value.model.module !== 'string' || !value.model.module.endsWith('.tla') || typeof value.model.config !== 'string' || !value.model.config.endsWith('.cfg') || !record(value.actions)) {
    fail('APP_MANIFEST_INVALID', 'Expected a version-1 app manifest with model files and action bindings.');
  }
  for (const path of [value.model.module, value.model.config]) {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('APP_MANIFEST_INVALID', 'Model paths must be relative project files.');
  }
  const entries = Object.entries(value.actions);
  if (!entries.length || entries.length > 100) fail('APP_MANIFEST_INVALID', 'The manifest needs between 1 and 100 actions.');
  const actions = Object.fromEntries(entries.map(([name, binding]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_!]*$/.test(name) || name.length > 128) fail('APP_MANIFEST_INVALID', 'Action IDs must be TLA+ operator names.');
    return [name, sourceBinding(binding, name)];
  }));
  if (!record(value.adapter) || typeof value.adapter.file !== 'string' || typeof value.adapter.global !== 'string') fail('APP_MANIFEST_INVALID', 'The manifest needs an adapter file and global name.');
  const adapterBinding = sourceBinding({file:value.adapter.file, function:value.adapter.global}, 'Adapter');
  return {
    version:1, model:{module:value.model.module, config:value.model.config},
    adapter:{file:adapterBinding.file, global:adapterBinding.function}, actions,
    observe:sourceBinding(value.observe, 'Observation'), reset:sourceBinding(value.reset, 'Reset'),
  };
}

function expectedValues(variables) {
  if (!record(variables) || Object.keys(variables).length > 256) fail('APP_STATE_UNSUPPORTED', 'Expected a bounded map of printed model variables.');
  return Object.fromEntries(Object.entries(variables).map(([name, printed]) => {
    if (!name || typeof printed !== 'string' || printed.length > 1024 * 1024) fail('APP_STATE_UNSUPPORTED', 'Model variables need names and printed literal values.');
    const literal = printed.trim();
    let value;
    if (literal === 'TRUE' || literal === 'FALSE') value = literal === 'TRUE';
    else if (/^-?(?:0|[1-9][0-9]*)$/.test(literal) && Number.isSafeInteger(Number(literal))) value = Number(literal);
    else if (literal.startsWith('"')) {
      try { value = JSON.parse(literal); } catch { /* Report unsupported literal below. */ }
    }
    if (!['string','boolean','number'].includes(typeof value)) fail('APP_STATE_UNSUPPORTED', 'Linked apps currently support string, boolean, and safe integer variables only: ' + name + '.');
    return [name, value];
  }));
}

function observation(value) {
  if (!record(value) || Object.keys(value).length > 256) fail('APP_SNAPSHOT_INVALID', 'The app must return a plain observation object.');
  for (const [name, item] of Object.entries(value)) {
    if (!name || (typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isSafeInteger(item))) || (typeof item === 'string' && item.length > 1024 * 1024)) fail('APP_SNAPSHOT_INVALID', 'Observed values must be strings, booleans, or safe integers.');
  }
  return copy(value);
}

export function compareAppState(expectedVariables, observed) {
  const expected = expectedValues(expectedVariables);
  const actual = observation(observed);
  const differences = [];
  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!own(expected, name)) differences.push({name, reason:'unexpected variable', observed:actual[name]});
    else if (!own(actual, name)) differences.push({name, reason:'missing variable', expected:expected[name]});
    else if (expected[name] !== actual[name]) differences.push({name, reason:'different value', expected:expected[name], observed:actual[name]});
  }
  return {matches:differences.length === 0, expected, observed:actual, differences};
}

function modelVariables(state) {
  if (!record(state) || !record(state.variables)) fail('APP_STATE_UNSUPPORTED', 'Expected a state produced by the local model engine.');
  expectedValues(state.variables);
  return state.variables;
}

export function createAppConformance(client, inputManifest) {
  const manifest = validateAppManifest(inputManifest);
  if (typeof client?.request !== 'function') throw new TypeError('An app bridge client is required.');
  let synchronized = false, busy = false, generation = 0, lastObservation = null;
  const invalidate = () => { synchronized = false; ++generation; };
  client.onDisconnect?.(invalidate);

  async function run(operation) {
    if (busy) fail('APP_BUSY', 'An application check is already running.');
    busy = true;
    const current = generation;
    const check = () => { if (current !== generation) fail('APP_CANCELLED', 'Application check cancelled; reset or replay before continuing.'); };
    const request = async (method, action) => {
      check();
      const binding = method === 'perform' ? manifest.actions[action] : manifest[method];
      const result = await client.request(method, action, {...binding});
      check();
      return result;
    };
    const verify = (state, raw, label) => {
      check();
      const result = compareAppState(modelVariables(state), raw);
      lastObservation = result.observed;
      if (!result.matches) {
        const detail = result.differences.map(item => item.name + ': expected ' + (own(item,'expected') ? JSON.stringify(item.expected) : '(absent)') + ', observed ' + (own(item,'observed') ? JSON.stringify(item.observed) : '(absent)')).join('; ');
        fail('APP_STATE_MISMATCH', label + ' does not match the model: ' + detail + '.', result);
      }
      return copy(lastObservation);
    };
    try {
      const result = await operation({request, verify, check});
      check();
      synchronized = true;
      return result;
    } catch (error) {
      synchronized = false;
      throw error;
    } finally { busy = false; }
  }

  const knownAction = action => {
    if (typeof action !== 'string' || !own(manifest.actions, action)) fail('APP_ACTION_UNBOUND', 'No application binding for action ' + String(action) + '.');
  };
  const reset = expectedState => run(async ({request, verify}) => {
    modelVariables(expectedState);
    synchronized = false;
    await request('reset');
    return verify(expectedState, await request('observe'), 'Reset observation');
  });
  const perform = (action, fromState, toState) => run(async ({request, verify}) => {
    if (!synchronized) fail('APP_NOT_SYNCHRONIZED', 'Reset or replay the application before choosing an action.');
    knownAction(action);
    modelVariables(fromState);modelVariables(toState);
    synchronized = false;
    verify(fromState, await request('observe'), 'Current application state');
    await request('perform', action);
    return verify(toState, await request('observe'), action + ' observation');
  });
  const replay = (steps, index) => run(async ({request, verify}) => {
    if (!Array.isArray(steps) || !Number.isInteger(index) || index < 0 || index >= steps.length || index > 200 || steps[0]?.action !== null) fail('APP_REPLAY_INVALID', 'Choose a valid trace prefix starting at Init.');
    const prefix = steps.slice(0, index + 1);
    for (const [position, step] of prefix.entries()) {
      modelVariables(step?.state);
      if (position) knownAction(step.action);
    }
    synchronized = false;
    await request('reset');
    let actual = verify(prefix[0].state, await request('observe'), 'Replay Init');
    for (let position = 1; position < prefix.length; position++) {
      const step = prefix[position];
      verify(prefix[position-1].state, await request('observe'), 'Replay source at step ' + position);
      await request('perform', step.action);
      actual = verify(step.state, await request('observe'), 'Replay step ' + position + ' (' + step.action + ')');
    }
    return actual;
  });
  return Object.freeze({
    get synchronized() { return synchronized; },
    get lastObservation() { return lastObservation === null ? null : copy(lastObservation); },
    reset, perform, replay, invalidate,
  });
}
