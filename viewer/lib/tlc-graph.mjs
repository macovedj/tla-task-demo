/** Browser-compatible readers for TLC's -dump dot,actionlabels output.
 * The graph is directed: repeated states and cycles are intentionally preserved.
 */

const MAX_STATES = 50_000;
const MAX_TRANSITIONS = 300_000;
const MAX_INPUT_LENGTH = 16 * 1024 * 1024;
const MAX_DOT_TOKENS = 1_000_000;

/** Decode DOT quoted strings without treating TLA+ expressions as JavaScript. */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (tokens.length >= MAX_DOT_TOKENS) throw new Error('The DOT structure is too large to import. Reduce the model size or export a smaller graph.');
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i) || c === '#') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"') {
      let value = '';
      let closed = false;
      i++;
      while (i < text.length) {
        const part = text[i++];
        if (part === '"') { closed = true; break; }
        if (part !== '\\') { value += part; continue; }
        if (i >= text.length) break;
        const escaped = text[i++];
        if (escaped === '\n') continue;
        value += ({ n: '\n', r: '\r', t: '\t', l: '\n', '"': '"', '\\': '\\' })[escaped] ?? `\\${escaped}`;
      }
      tokens.push({ type: 'value', value, closed });
      continue;
    }
    if (text.startsWith('->', i)) {
      tokens.push({ type: 'arrow', value: '->' }); i += 2; continue;
    }
    if ('[]{}=;,:'.includes(c)) {
      tokens.push({ type: c, value: c }); i++; continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i]) && !'[]{}=;,:"'.includes(text[i]) && !text.startsWith('->', i)) i++;
    tokens.push({ type: 'value', value: text.slice(start, i) });
  }
  return tokens;
}

/** Parse TLC variable assignments, retaining compound values as printed by TLC. */
export function parseVariables(label) {
  const source = String(label || '').trim();
  // Horizontal whitespace only: allowing \s across newlines here makes a long
  // sequence of blank lines quadratic to scan on malformed imported labels.
  const matches = [...source.matchAll(/(?:^|\n)[ \t]*\/\\[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/g)];
  if (!matches.length) {
    const single = source.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    return single ? { [single[1]]: single[2].trim() } : {};
  }
  return Object.fromEntries(matches.map((match, index) => [
    match[1], source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).trim(),
  ]));
}

/**
 * Read actual TLC DOT output, including partially flushed output after a timeout.
 * DOT alone cannot certify model-check completion; complete therefore defaults false.
 */
export function parseTlcDot(text, name = 'Imported model') {
  if (typeof text === 'string' && text.length > MAX_INPUT_LENGTH) throw new Error('The graph file exceeds the 16 MiB text import limit.');
  if (typeof text !== 'string' || !/\b(?:strict\s+)?digraph\b/.test(text.slice(0, 2048))) {
    throw new Error('Expected a directed TLC .dot graph. Generate one with -dump dot,actionlabels graph.dot.');
  }
  const tokens = tokenize(text);
  let cursor = 0;
  const nodes = new Map();
  const edges = [];
  let missingLabels = false;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const attributes = () => {
    const attrs = {};
    while (peek()?.type === '[') {
      take();
      while (peek() && peek().type !== ']') {
        const key = take();
        if (key.type !== 'value') continue;
        if (peek()?.type !== '=') continue;
        take();
        const value = take();
        if (value?.type === 'value' && value.closed !== false) attrs[key.value.toLowerCase()] = value.value;
      }
      if (peek()?.type === ']') take();
    }
    return attrs;
  };
  const block = (ignored = false, depth = 0) => {
    if (depth > 64) throw new Error('The DOT graph contains too many nested subgraphs.');
    while (peek()) {
      if (peek().type === '}') { take(); return; }
      if (peek().type === '{') { take(); block(ignored, depth + 1); continue; }
      const item = take();
      if (item.type !== 'value') continue;
      if (item.value === 'subgraph') {
        const id = peek()?.type === 'value' ? take().value : '';
        if (peek()?.type === '{') { take(); block(ignored || /legend/i.test(id), depth + 1); }
        continue;
      }
      if (peek()?.type === '=') {
        take(); if (peek()?.type === 'value') take();
        continue;
      }
      if (peek()?.type === 'arrow') {
        const chain = [item.value];
        while (peek()?.type === 'arrow') {
          take();
          if (peek()?.type !== 'value') break;
          chain.push(take().value);
        }
        const attrs = attributes();
        if (!ignored) {
          for (let n = 1; n < chain.length; n++) {
            if (edges.length >= MAX_TRANSITIONS) throw new Error(`Graph exceeds the ${MAX_TRANSITIONS.toLocaleString()} transition import limit.`);
            const action = attrs.label?.trim() || (attrs.style === 'dashed' ? 'Stuttering' : 'Next');
            if (!attrs.label && attrs.style !== 'dashed') missingLabels = true;
            edges.push({ id: `t${edges.length}`, source: chain[n - 1], target: chain[n], action });
          }
        }
        continue;
      }
      if (peek()?.type === '[') {
        const attrs = attributes();
        if (ignored || ['node', 'edge', 'graph'].includes(item.value) || attrs.label === undefined) continue;
        const rawState = attrs.tooltip || attrs.label;
        const variables = parseVariables(rawState);
        // Action legends and DOT decoration are not model states.
        if (!Object.keys(variables).length && !/^-?\d+$/.test(item.value)) continue;
        const previous = nodes.get(item.value);
        const constrained = /lightyellow/i.test(attrs.fillcolor || '');
        nodes.set(item.value, {
          ...previous,
          id: item.value,
          variables,
          label: attrs.label,
          initial: previous?.initial || (/\bfilled\b/.test(attrs.style || '') && !constrained),
          ...(constrained ? { constrained: true } : {}),
        });
        if (nodes.size > MAX_STATES) throw new Error(`Graph exceeds the ${MAX_STATES.toLocaleString()} state import limit.`);
      }
    }
  };
  while (peek() && peek().type !== '{') take();
  if (!peek()) throw new Error('The DOT graph has no graph body.');
  take();
  block();
  if (!nodes.size) throw new Error('No state assignments were found in this DOT file. Import a TLC state graph, rather than an action graph.');
  // A killed process can leave references to states whose labels were not flushed.
  // Keep only states with real data, and make the incomplete import explicit.
  const transitions = edges.filter(edge => nodes.has(edge.source) && nodes.has(edge.target));
  const warnings = [];
  if (edges.length !== transitions.length) warnings.push(`${edges.length - transitions.length} transition(s) refer to missing state data and were omitted.`);
  if (![...nodes.values()].some(state => state.initial)) warnings.push('No initial-state markers were present. Paths from initial states are unavailable.');
  if (missingLabels) warnings.push('Some transitions have no action label. Use TLC -dump dot,actionlabels to include action names.');
  return validateGraph({ name, source: 'TLC', complete: false, states: [...nodes.values()], transitions, warnings });
}

function valueText(value) {
  if (typeof value === 'string') return value;
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  if (value === null) return 'null';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Validate exported graph JSON without assuming arbitrary JSON is a TLC proof. */
export function validateGraph(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.states) || !Array.isArray(input.transitions)) {
    throw new Error('Graph JSON must contain states and transitions arrays. Import an export from this explorer or a TLC .dot state graph.');
  }
  if (!input.states.length) throw new Error('The graph contains no states.');
  if (input.states.length > MAX_STATES || input.transitions.length > MAX_TRANSITIONS) throw new Error('The graph is too large to import (50,000 states / 300,000 transitions maximum).');
  const ids = new Set();
  const states = input.states.map((state, index) => {
    if (!state || typeof state !== 'object' || state.id === undefined || state.id === null) throw new Error(`State ${index + 1} has no ID.`);
    if (typeof state.id !== 'string' && (!Number.isSafeInteger(state.id))) throw new Error(`State ${index + 1} needs a string or safe integer ID. Quote TLC fingerprints to preserve their precision.`);
    const id = String(state.id);
    if (!id || ids.has(id)) throw new Error(`Duplicate or empty state ID: ${id || '(empty)'}.`);
    ids.add(id);
    if (!state.variables || typeof state.variables !== 'object' || Array.isArray(state.variables)) throw new Error(`State ${id} needs a variables object.`);
    const variables = Object.fromEntries(Object.entries(state.variables).map(([key, value]) => [key, valueText(value)]));
    return { ...state, id, variables, initial: state.initial === true };
  });
  const transitionIds = new Set();
  const transitions = input.transitions.map((transition, index) => {
    if (!transition || typeof transition !== 'object') throw new Error(`Transition ${index + 1} is invalid.`);
    if ([transition.source, transition.target].some(id => typeof id !== 'string' && !Number.isSafeInteger(id))) {
      throw new Error(`Transition ${index + 1} needs string or safe integer endpoints. Quote TLC fingerprints to preserve their precision.`);
    }
    const source = String(transition.source);
    const target = String(transition.target);
    if (!ids.has(source) || !ids.has(target)) throw new Error(`Transition ${index + 1} references an unknown state.`);
    const id = String(transition.id ?? `t${index}`);
    if (transitionIds.has(id)) throw new Error(`Duplicate transition ID: ${id}.`);
    transitionIds.add(id);
    const action = typeof transition.action === 'string' ? transition.action.trim() : '';
    return { ...transition, id, source, target, action: action || 'Next' };
  });
  return {
    ...input,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Imported model',
    source: ['TLC', 'WASM', 'example', 'import'].includes(input.source) ? input.source : 'import',
    complete: input.complete === true,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter(warning => typeof warning === 'string') : [],
    states,
    transitions,
    actions: [...new Set(transitions.map(transition => transition.action))],
  };
}

export function parseGraphJson(text, name) {
  if (typeof text === 'string' && text.length > MAX_INPUT_LENGTH) throw new Error('The graph file exceeds the 16 MiB text import limit.');
  let input;
  try { input = typeof text === 'string' ? JSON.parse(text) : text; }
  catch { throw new Error('The selected file is not valid JSON.'); }
  const graph = validateGraph(input?.graph || input);
  return {
    ...graph,
    ...(name ? { name } : {}),
    source: 'import',
    metadata: {
      ...(graph.metadata && typeof graph.metadata === 'object' && !Array.isArray(graph.metadata) ? graph.metadata : {}),
      reportedComplete: graph.complete,
    },
  };
}

export function incomingTransitions(graph, stateId) {
  return graph.transitions.filter(transition => transition.target === String(stateId));
}

export function outgoingTransitions(graph, stateId) {
  return graph.transitions.filter(transition => transition.source === String(stateId));
}

/** Breadth-first path over every matching edge, preserving branching and cycles. */
export function shortestPath(graph, targetId, { startId, actions } = {}) {
  const target = String(targetId);
  if (!graph.states.some(state => state.id === target)) return null;
  const starts = startId !== undefined ? [String(startId)] : graph.states.filter(state => state.initial).map(state => state.id);
  if (!starts.length) return null;
  const allowed = actions === undefined ? null : new Set(actions);
  const adjacency = new Map();
  for (const transition of graph.transitions) {
    if (allowed && !allowed.has(transition.action)) continue;
    if (!adjacency.has(transition.source)) adjacency.set(transition.source, []);
    adjacency.get(transition.source).push(transition);
  }
  const seen = new Map(starts.map(id => [id, null]));
  const queue = [...starts];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === target) break;
    for (const transition of adjacency.get(current) || []) {
      if (seen.has(transition.target)) continue;
      seen.set(transition.target, transition);
      queue.push(transition.target);
    }
  }
  if (!seen.has(target)) return null;
  const states = [target];
  const transitions = [];
  let current = target;
  while (seen.get(current)) {
    const transition = seen.get(current);
    transitions.push(transition.id);
    states.push(transition.source);
    current = transition.source;
  }
  return { states: states.reverse(), transitions: transitions.reverse() };
}
