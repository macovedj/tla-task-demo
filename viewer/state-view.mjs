/**
 * Compact, lossless views of printed TLA+ values.
 * This is a display parser only: values are never evaluated or coerced to JSON.
 */
const MAX_PARSE_LENGTH = 256 * 1024;
const MAX_CHILDREN = 200;
const MAX_DEPTH = 6;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const own = (object, key) => Object.hasOwn(object || {}, key);
const normalizedMode = mode => mode === 'changed' || mode === 'changes' ? 'changed' : 'all';
const mounted = new WeakMap();
const bound = new WeakMap();

/** Split a display expression only outside quoted strings and balanced literals. */
function splitTopLevel(source, separator) {
  const pieces = [];
  const stack = [];
  let start = 0, quoted = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quoted) {
      if (character === '\\') { i++; continue; }
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (!stack.length && source.startsWith(separator, i)) {
      pieces.push(source.slice(start, i).trim());
      i += separator.length - 1;
      start = i + 1;
      continue;
    }
    if (source.startsWith('<<', i)) { stack.push('>>'); i++; continue; }
    if (source.startsWith('>>', i)) {
      if (stack.pop() !== '>>') return null;
      i++; continue;
    }
    if ('[{('.includes(character)) { stack.push({'[':']','{':'}','(':')'}[character]); continue; }
    if (']})'.includes(character) && stack.pop() !== character) return null;
  }
  if (quoted || stack.length) return null;
  pieces.push(source.slice(start).trim());
  return pieces;
}

function pairAtTopLevel(source, separator) {
  const parts = splitTopLevel(source, separator);
  return parts?.length === 2 && parts[0] && parts[1] ? parts : null;
}

/** Keep raw text alongside any successfully recognized literal structure. */
export function parsePrintedValue(value) {
  const raw = String(value ?? '');
  const source = raw.trim();
  const scalar = {kind:'scalar',raw,children:null};
  if (!source || source.length > MAX_PARSE_LENGTH) return scalar;
  let kind, open, close, body;
  if (source.startsWith('<<') && source.endsWith('>>')) { kind='sequence';open='<<';close='>>';body=source.slice(2,-2); }
  else if (source.startsWith('{') && source.endsWith('}')) { kind='set';open='{';close='}';body=source.slice(1,-1); }
  else if (source.startsWith('[') && source.endsWith(']')) { kind='record';open='[';close=']';body=source.slice(1,-1); }
  else if (source.startsWith('(') && source.endsWith(')')) { kind='function';open='(';close=')';body=source.slice(1,-1); }
  else return scalar;
  const separator = kind === 'function' ? '@@' : ',';
  const parts = body.trim() ? splitTopLevel(body, separator) : [];
  if (!parts || parts.some(part => !part)) return scalar;
  const children = [];
  for (let index=0;index<parts.length;index++) {
    const part = parts[index];
    if (kind === 'record' || kind === 'function') {
      const pair = pairAtTopLevel(part,kind === 'record'?'|->':':>');
      if (!pair) return scalar;
      children.push({key:pair[0],raw:pair[1]});
    } else children.push({key:String(index),raw:part,index});
  }
  return {kind,raw,open,close,children};
}

function tokenClass(raw) {
  const source = raw.trim();
  if (/^-?\d+$/.test(source)) return 'sv-number';
  if (/^(?:TRUE|FALSE|true|false)$/.test(source)) return 'sv-boolean';
  if (source.startsWith('"') && source.endsWith('"')) return 'sv-string';
  return 'sv-token';
}
function preview(raw) {
  const single = String(raw).replace(/\s*\n\s*/g,' ').replace(/\r/g,'');
  return single.length > 180 ? single.slice(0,177)+'…' : single;
}
function displayKey(key, rawKey = false) {
  return escapeHtml(rawKey ? key : JSON.stringify(key));
}
function oldMarkup(before, after, changed) {
  if (!changed) return '';
  const value=before === undefined?'(absent)':before;
  return '<span class="sv-before" title="'+escapeHtml(value)+'">'+escapeHtml(preview(value))+'</span><span class="sv-arrow" aria-hidden="true">→</span>';
}
function valueNode({key,raw,before,changed=false,removed=false,comma=false,depth=1,path,rawKey=false}, budget) {
  const value = removed ? '(absent)' : raw;
  const parsed = parsePrintedValue(value);
  const expandable = !removed && (parsed.children !== null || value.length > 100 || /[\r\n]/.test(value));
  const name = '<span class="sv-key">'+displayKey(key,rawKey)+'</span><span class="sv-punctuation">: </span>';
  const tokens = oldMarkup(before,value,changed)+'<span class="sv-value '+tokenClass(value)+(removed?' sv-absent':'')+'">'+escapeHtml(expandable?preview(value):value)+'</span><span class="sv-punctuation">'+(comma?',':'')+'</span>';
  const classes = 'sv-property'+(changed?' sv-changed':'')+(removed?' sv-removed':'');
  const indent = 'style="--sv-depth:'+depth+'"';
  if (!expandable) return '<div class="'+classes+' sv-line" '+indent+'><span class="sv-twisty-spacer"></span>'+name+tokens+'</div>';
  let body;
  if (parsed.children !== null && depth < MAX_DEPTH && budget.remaining > 0) {
    const shown = parsed.children.slice(0,Math.min(MAX_CHILDREN,budget.remaining));
    budget.remaining -= shown.length;
    body='<div class="sv-children">'+shown.map((child,index)=>valueNode({
      key:child.key,raw:child.raw,depth:depth+1,path:path+'.'+index,rawKey:parsed.kind==='record'||parsed.kind==='function',comma:index<parsed.children.length-1
    },budget)).join('')+
      (shown.length<parsed.children.length?'<div class="sv-line sv-limit" style="--sv-depth:'+(depth+1)+'">… '+(parsed.children.length-shown.length)+' more; see raw value</div>':'')+
      '<details class="sv-raw"><summary class="sv-line" style="--sv-depth:'+(depth+1)+'">raw</summary><pre>'+escapeHtml(value)+'</pre></details></div>';
  } else body='<pre class="sv-raw-value">'+escapeHtml(value)+'</pre>';
  return '<details class="'+classes+' sv-node" data-sv-path="'+escapeHtml(path)+'" '+indent+'><summary class="sv-line"><span class="sv-twisty" aria-hidden="true">▸</span>'+name+tokens+'</summary>'+body+'</details>';
}

/** Object-like text for copying: field keys use JSON quoting; TLA values stay raw. */
export function formatState(variables = {}) {
  return '{\n'+Object.entries(variables).map(([key,value])=>'  '+JSON.stringify(key)+': '+String(value)).join(',\n')+'\n}';
}

/** Markup is safe to insert as HTML. Full printed values are retained on expansion. */
export function stateMarkup({variables = {},previous,mode='all',query='',idPrefix='state'} = {}) {
  const filter = String(query).toLocaleLowerCase();
  const keys = [...new Set([...Object.keys(variables),...Object.keys(previous||{})])];
  const entries = keys.map(key=>{
    const present=own(variables,key),wasPresent=own(previous,key);
    const value=present?String(variables[key]):undefined,before=wasPresent?String(previous[key]):undefined;
    const changed=Boolean(previous)&&(present!==wasPresent||value!==before);
    return {key,raw:value??'',before,changed,removed:!present};
  }).filter(entry=>(normalizedMode(mode)!=='changed'||entry.changed)&&(!filter||(entry.key+' '+entry.raw+' '+(entry.before||'')).toLocaleLowerCase().includes(filter)));
  const budget={remaining:2000};
  const body=entries.map((entry,index)=>valueNode({...entry,comma:index<entries.length-1,path:String(idPrefix)+'.'+JSON.stringify(entry.key)},budget)).join('');
  return '<div class="state-view" data-state-view data-sv-mode="'+normalizedMode(mode)+'"><div class="sv-line sv-brace">{</div><div class="sv-properties">'+
    (body||'<div class="sv-line sv-empty" style="--sv-depth:1">'+(normalizedMode(mode)==='changed'?'// no changed fields':'// no matching fields')+'</div>')+
    '</div><div class="sv-line sv-brace">}</div></div>';
}

function setExpanded(root,expanded) {
  root.querySelectorAll('details.sv-node').forEach(node=>{node.open=expanded;});
}
function toolbarMarkup({mode,query,previous}) {
  return '<div class="sv-toolbar"><div class="sv-modes"><button type="button" data-sv-command="all" class="'+(mode==='all'?'active':'')+'">All</button><button type="button" data-sv-command="changed" class="'+(mode==='changed'?'active':'')+'" '+(!previous?'disabled':'')+'>Changes</button></div><input type="search" data-sv-query aria-label="Filter state fields" placeholder="filter fields" value="'+escapeHtml(query)+'"><button type="button" data-sv-command="expand" title="Expand all values">Expand</button><button type="button" data-sv-command="collapse" title="Collapse all values">Collapse</button><button type="button" data-sv-command="copy" title="Copy state with exact TLA values">Copy</button></div>';
}

/** Bind expand/collapse/copy controls surrounding stateMarkup, once per root. */
export function bindStateView(root) {
  if (!root || bound.has(root)) return;
  const click = async event=>{
    const button=event.target.closest?.('[data-sv-command]');
    if (!button || !root.contains(button)) return;
    const command=button.dataset.svCommand;
    if (command==='expand'||command==='collapse') { setExpanded(root,command==='expand');return; }
    const instance=mounted.get(root);
    if (!instance)return;
    if (command==='all'||command==='changed') {
      instance.mode=command;paint(root,instance);return;
    }
    if (command==='copy') {
      try {
        if(!globalThis.navigator?.clipboard?.writeText)throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(formatState(instance.options.variables));
        button.textContent='Copied';
        setTimeout(()=>{if(button.isConnected)button.textContent='Copy';},900);
      }catch{button.textContent='Copy unavailable';}
    }
  };
  const input = event=>{
    if (!event.target.matches?.('[data-sv-query]'))return;
    const instance=mounted.get(root);if(!instance)return;
    instance.query=event.target.value;
    const position=event.target.selectionStart;
    paint(root,instance);
    const next=root.querySelector('[data-sv-query]');next?.focus();
    if(position!==null)try{next?.setSelectionRange(position,position);}catch{}
  };
  root.addEventListener('click',click);
  root.addEventListener('input',input);
  bound.set(root,{click,input});
}

function paint(container,instance) {
  const openPaths=new Set([...container.querySelectorAll('details.sv-node[open]')].map(node=>node.dataset.svPath));
  container.innerHTML=(instance.options.controls?toolbarMarkup({...instance,previous:instance.options.previous}):'')+stateMarkup({...instance.options,mode:instance.mode,query:instance.query});
  container.querySelectorAll('details.sv-node').forEach(node=>{node.open=openPaths.has(node.dataset.svPath);});
}

/** Mount a compact state tree, optionally with a single-line developer toolbar. */
export function renderStateView(container,options = {}) {
  const old=mounted.get(container);
  const instance={options:{...options},mode:normalizedMode(options.mode??old?.mode),query:String(options.query??old?.query??'')};
  mounted.set(container,instance);
  paint(container,instance);
  bindStateView(container);
}
