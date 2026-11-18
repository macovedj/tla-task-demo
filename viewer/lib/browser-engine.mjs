import { parseTlcDot, validateGraph } from './tlc-graph.mjs';

export const BROWSER_ENGINE_VERSION = '0.24.11';
export const BROWSER_LIMITS = Object.freeze({ maxStates: 5000, maxDepth: 100, maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024 });
const SOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.(?:tla|cfg)$/;
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const encoder = new TextEncoder();

export class BrowserModelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BrowserModelError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new BrowserModelError(code, message, details); }
function limit(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) fail('INVALID_LIMIT', `${label} must be an integer between 1 and ${max.toLocaleString()}.`);
  return value;
}

/** Validate sources without evaluating JavaScript or performing any I/O. */
export function prepareBrowserRequest(request) {
  if (!request || !Array.isArray(request.files) || !request.files.length || request.files.length > BROWSER_LIMITS.maxFiles) fail('INVALID_FILES', `Choose between 1 and ${BROWSER_LIMITS.maxFiles} .tla and .cfg files.`);
  const files = new Map();
  let size = 0;
  for (const file of request.files) {
    if (!file || typeof file.name !== 'string' || !SOURCE_NAME.test(file.name) || typeof file.content !== 'string') fail('INVALID_FILE', 'Use simple module filenames with lowercase .tla or .cfg extensions. Directory paths are not accepted.');
    if (files.has(file.name)) fail('DUPLICATE_FILE', `The filename ${file.name} appears more than once.`);
    const bytes = encoder.encode(file.content).length;
    if (bytes > BROWSER_LIMITS.maxFileBytes) fail('SOURCE_TOO_LARGE', `${file.name} exceeds the 1 MiB source-file limit.`);
    size += bytes;
    if (size > BROWSER_LIMITS.maxTotalBytes) fail('SOURCES_TOO_LARGE', 'The source files exceed the 3 MiB browser-analysis limit.');
    files.set(file.name, file.content);
  }
  const rootModule = String(request.rootModule || '').replace(/\.tla$/, '');
  if (!MODULE_NAME.test(rootModule) || !files.has(`${rootModule}.tla`)) fail('INVALID_ROOT', 'Select an uploaded .tla root module.');
  const sources = Object.fromEntries([...files].filter(([name]) => name.endsWith('.tla')));
  for (const [name, source] of Object.entries(sources)) {
    const declared = source.match(/^[ \t]*-{4,}[ \t]*MODULE[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*-{4,}[ \t]*\r?$/m)?.[1];
    if (!declared) fail('INVALID_MODULE', `${name} needs a valid TLA+ MODULE header.`);
    if (`${declared}.tla` !== name) fail('MODULE_NAME_MISMATCH', `${name} declares MODULE ${declared}. The filename must match the declared module name.`);
  }
  let cfgSource;
  if (request.config !== undefined) {
    if (typeof request.config !== 'string') fail('INVALID_CONFIG', 'The model configuration must be text.');
    cfgSource = request.config;
  } else if (request.configFile !== undefined) {
    if (typeof request.configFile !== 'string' || !request.configFile.endsWith('.cfg') || !files.has(request.configFile)) fail('INVALID_CONFIG', 'Select an uploaded .cfg model configuration.');
    cfgSource = files.get(request.configFile);
  } else {
    const cfgs = [...files.keys()].filter(name => name.endsWith('.cfg'));
    cfgSource = files.get(`${rootModule}.cfg`) ?? (cfgs.length === 1 ? files.get(cfgs[0]) : '');
  }
  if (!cfgSource?.trim()) fail('CONFIG_REQUIRED', 'Provide a finite TLC-style model configuration with INIT/NEXT or SPECIFICATION and any constant assignments.');
  if (encoder.encode(cfgSource).length > BROWSER_LIMITS.maxFileBytes) fail('CONFIG_TOO_LARGE', 'The model configuration exceeds the 1 MiB text limit.');
  const maxStates = limit(request.limits?.maxStates, BROWSER_LIMITS.maxStates, 20000, 'State limit');
  const maxDepth = limit(request.limits?.maxDepth, BROWSER_LIMITS.maxDepth, 1000, 'Depth limit');
  return { rootModule, sources, options: { cfg_source: cfgSource, max_states: maxStates, max_depth: maxDepth, allow_deadlock: false, export_dot: true, dot_mode: 'full' } };
}

/** tla-rs DOT labels use one name=value assignment per escaped newline. */
export function parseRustVariables(label) {
  const source = String(label || '').trim();
  const assignments = [...source.matchAll(/(?:^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/g)];
  return Object.fromEntries(assignments.map((match, index) => [match[1], source.slice(match.index + match[0].length, assignments[index + 1]?.index ?? source.length).trim()]));
}

export function normalizeBrowserResult(result, name, { durationMs = 0, limits } = {}) {
  if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') fail('ENGINE_RESPONSE', 'The browser engine returned an invalid result. Reload the page and try again.');
  const errorType = typeof result.error_type === 'string' ? result.error_type : null;
  const errorMessage = typeof result.error_message === 'string' ? result.error_message : null;
  const warnings = [...new Set((Array.isArray(result.warnings) ? result.warnings : []).map(String))];
  const output = [
    `tla-rs ${BROWSER_ENGINE_VERSION} · WebAssembly · browser-local`,
    result.success ? (warnings.length ? 'Model exploration completed with engine warnings; review is required.' : 'Model exploration completed.') : `${errorType || 'AnalysisError'}: ${errorMessage || 'Analysis did not complete.'}`,
    Number.isSafeInteger(result.states_explored) ? `${result.states_explored.toLocaleString()} states explored by the engine.` : '',
    ...warnings,
    ...(Array.isArray(result.trace) ? result.trace.map(String) : []),
  ].filter(Boolean).join('\n');
  if (typeof result.dot !== 'string' || !result.dot.trim()) {
    fail(errorType || 'ANALYSIS_FAILED', errorMessage || 'The model did not produce any reachable states.', { output, warnings });
  }
  let graph;
  try { graph = parseTlcDot(result.dot, name); }
  catch (error) { fail('GRAPH_RESPONSE', `The browser engine produced an unreadable state graph: ${error.message}`, { output }); }
  // Generic TLC parsing treats filled error nodes as initial. Only the explicit
  // source-map binding's initial IDs certify which tla-rs nodes are initial.
  const initialIds = new Set(Array.isArray(result.initial_state_ids) ? result.initial_state_ids.map(String) : []);
  if (!Array.isArray(result.initial_state_ids)) fail('ENGINE_INCOMPATIBLE', 'This browser engine is missing initial-state metadata. Reload to get the current engine.');
  const graphStateIds = new Set(graph.states.map(state => state.id));
  if (!initialIds.size || [...initialIds].some(id => !graphStateIds.has(id))) fail('GRAPH_RESPONSE', 'The browser engine did not identify valid initial states.', { output });
  // Upstream warnings can report skipped or unsupported semantics. Preserve the
  // graph for inspection without presenting such a run as a verified complete result.
  const complete = result.success === true && warnings.length === 0;
  const stateVariables = graph.states.map(state => ({ ...state, variables: parseRustVariables(state.label), initial: initialIds.has(state.id) }));
  if (stateVariables.some(state => !Object.keys(state.variables).length)) fail('GRAPH_RESPONSE', 'The browser engine returned a state without readable variable assignments.', { output });
  if (!complete) warnings.push(errorMessage || (result.success ? 'The engine emitted warnings. Review them before relying on this exploration as complete.' : 'Analysis stopped before complete exploration. Additional states and actions may exist.'));
  graph = validateGraph({
    ...graph,
    source: 'WASM',
    complete,
    states: stateVariables,
    warnings: [...new Set([...graph.warnings.filter(warning => !warning.startsWith('No initial-state markers were present.')), ...warnings])],
    metadata: { engine: `tla-rs ${BROWSER_ENGINE_VERSION}`, runtime: 'WebAssembly', execution: 'browser-local', limits, errorType },
  });
  const violation = ['InvariantViolation', 'PropertyViolation', 'LivenessViolation', 'RefinementViolation', 'Deadlock'].includes(errorType);
  return {
    graph,
    dot: result.dot,
    run: { status: complete ? 'complete' : violation ? 'violation' : 'partial', complete, durationMs, engine: `tla-rs ${BROWSER_ENGINE_VERSION}`, execution: 'browser-local', errorType, output, warnings: graph.warnings, stats: { states: graph.states.length, transitions: graph.transitions.length } },
  };
}

/** Run the genuine Rust checker. This function has no network/filesystem access. */
export function analyzeBrowserModel(engine, request) {
  if (typeof engine?.check_spec_with_modules !== 'function') fail('ENGINE_INCOMPATIBLE', 'This browser engine does not support in-memory source modules. Reload to get the current engine.');
  const prepared = prepareBrowserRequest(request);
  const started = performance.now();
  let result;
  try { result = JSON.parse(engine.check_spec_with_modules(prepared.rootModule, JSON.stringify(prepared.sources), JSON.stringify(prepared.options))); }
  catch (error) {
    if (error instanceof BrowserModelError) throw error;
    fail('ENGINE_FAILURE', `The browser engine could not finish this model: ${error.message || error}. Try smaller finite constants or check the supported TLA+ features.`);
  }
  return normalizeBrowserResult(result, prepared.rootModule, { durationMs: Math.round(performance.now() - started), limits: { maxStates: prepared.options.max_states, maxDepth: prepared.options.max_depth } });
}

function normalizeInteractiveState(value) {
  if (!value || typeof value !== 'object' || typeof value.key !== 'string' || typeof value.typedState !== 'string' || value.key !== value.typedState || value.typedState.length > 1024 * 1024 || !value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables) || Object.values(value.variables).some(item => typeof item !== 'string')) {
    fail('ENGINE_RESPONSE', 'The browser engine returned an invalid interactive state.');
  }
  return { key: value.key, typedState: value.typedState, variables: { ...value.variables }, invariants: normalizeInteractiveInvariants(value.invariants) };
}
function normalizeInteractiveInvariants(values) {
  if (!Array.isArray(values)) fail('ENGINE_RESPONSE', 'The browser engine returned invalid invariant checks.');
  return values.map(value => {
    if (!value || typeof value.name !== 'string' || (value.holds !== true && value.holds !== false && value.holds !== null) || (value.error !== undefined && typeof value.error !== 'string')) fail('ENGINE_RESPONSE', 'The browser engine returned an invalid invariant check.');
    return { name: value.name, holds: value.holds, ...(value.error ? { error: value.error } : {}) };
  });
}
function normalizeActionDiagnostics(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1000) fail('ENGINE_RESPONSE', 'The browser engine returned invalid action diagnostics.');
  return values.map(value => {
    if (!value || typeof value.action !== 'string' || !['available','blocked','filtered','no-outcomes','unknown'].includes(value.status) || !Array.isArray(value.guards) || !Array.isArray(value.parameters) || !Number.isSafeInteger(value.generatedCount) || value.generatedCount < 0 || !Number.isSafeInteger(value.availableCount) || value.availableCount < 0 || value.availableCount > value.generatedCount || (value.reason != null && typeof value.reason !== 'string')) fail('ENGINE_RESPONSE', 'The browser engine returned an invalid action diagnostic.');
    const guards = value.guards.map(guard => {
      if (!guard || typeof guard.expression !== 'string' || ![true,false,null].includes(guard.holds) || (guard.error != null && typeof guard.error !== 'string')) fail('ENGINE_RESPONSE', 'The browser engine returned invalid guard diagnostics.');
      return { expression:guard.expression, holds:guard.holds, ...(guard.error ? {error:guard.error} : {}) };
    });
    const parameters = value.parameters.map(parameter => {
      if (!parameter || typeof parameter.name !== 'string' || typeof parameter.value !== 'string') fail('ENGINE_RESPONSE', 'The browser engine returned invalid action parameters.');
      return {name:parameter.name,value:parameter.value};
    });
    return {action:value.action,status:value.status,guards,parameters,generatedCount:value.generatedCount,availableCount:value.availableCount,...(value.reason ? {reason:value.reason} : {})};
  });
}

function interactiveResult(value, type) {
  if (!value || typeof value.ok !== 'boolean') fail('ENGINE_RESPONSE', 'The browser engine returned an invalid interactive result.');
  if (!value.ok) fail(typeof value.error_type === 'string' ? value.error_type : 'INTERACTIVE_ERROR', typeof value.error === 'string' ? value.error : 'The browser engine could not generate this step.');
  const shared = { mode: 'interactive', execution: 'browser-local', verification: 'finite-trace-only', warnings: [...new Set((Array.isArray(value.warnings) ? value.warnings : []).map(String))], excludedByConstraints: Number.isSafeInteger(value.excludedByConstraints) ? value.excludedByConstraints : 0 };
  if (type === 'init') {
    if (!Array.isArray(value.states)) fail('ENGINE_RESPONSE', 'The browser engine returned invalid initial-state choices.');
    return { ...shared, states: value.states.map(normalizeInteractiveState) };
  }
  if (typeof value.fromKey !== 'string' || !Array.isArray(value.transitions)) fail('ENGINE_RESPONSE', 'The browser engine returned invalid action choices.');
  const transitions = value.transitions.map(transition => {
    if (!transition || typeof transition.action !== 'string' || !Array.isArray(transition.changes)) fail('ENGINE_RESPONSE', 'The browser engine returned an invalid action choice.');
    const changes = transition.changes.map(change => {
      if (!change || typeof change.name !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string') fail('ENGINE_RESPONSE', 'The browser engine returned invalid variable changes.');
      return { name: change.name, before: change.before, after: change.after };
    });
    return { action: transition.action, to: normalizeInteractiveState(transition.to), changes };
  });
  return { ...shared, fromKey: value.fromKey, invariants: normalizeInteractiveInvariants(value.invariants), transitions, actionDiagnostics:normalizeActionDiagnostics(value.actionDiagnostics), actionDiagnosticsTruncated:value.actionDiagnosticsTruncated===true };
}
function invokeInteractive(engine, request, type) {
  const binding = type === 'init' ? 'explore_init_with_modules' : 'explore_next_with_modules';
  if (typeof engine?.[binding] !== 'function') fail('ENGINE_INCOMPATIBLE', 'This browser engine does not support interactive module exploration. Reload to get the current engine.');
  const prepared = prepareBrowserRequest(request);
  if (type === 'next' && (typeof request.state !== 'string' || request.state.length > 1024 * 1024)) fail('INVALID_STATE', 'Choose a state produced by this browser engine to expand it.');
  let result;
  try {
    const arguments_ = [prepared.rootModule, JSON.stringify(prepared.sources), JSON.stringify(prepared.options)];
    if (type === 'next') arguments_.push(request.state);
    result = JSON.parse(engine[binding](...arguments_));
  } catch (error) { fail('ENGINE_FAILURE', 'The browser engine could not generate this step: ' + (error.message || error)); }
  return interactiveResult(result, type);
}
/** Generate configured Init choices; state tokens remain opaque to JavaScript. */
export function initializeBrowserTrace(engine, request) { return invokeInteractive(engine, request, 'init'); }
/** Generate genuine enabled Next choices, including states outside a saved graph. */
export function expandBrowserTrace(engine, request) { return invokeInteractive(engine, request, 'next'); }
