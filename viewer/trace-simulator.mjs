import { renderStateView } from './state-view.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const panelStates = new WeakMap();
const amount = value => Math.max(0, Number(value) || 0).toLocaleString();

function invoke(context, callback, ...args) {
  if (typeof context[callback] === 'function') context[callback](...args);
}
function invariantList(state) {
  return Array.isArray(state?.invariants) ? state.invariants.filter(item => item && typeof item.name === 'string') : [];
}
function checkCounts(state) {
  const checks = invariantList(state);
  return { checks, failures:checks.filter(check => check.holds === false).length, unknown:checks.filter(check => check.holds !== true && check.holds !== false).length };
}
function checkFlag(state) {
  const { failures, unknown } = checkCounts(state);
  if (failures) return '<span class="sim-check-flag sim-check-fail" title="'+amount(failures)+' invariant checks failed" aria-label="'+amount(failures)+' invariant checks failed">!</span>';
  if (unknown) return '<span class="sim-check-flag sim-check-unknown" title="'+amount(unknown)+' invariant checks not evaluated" aria-label="'+amount(unknown)+' invariant checks not evaluated">?</span>';
  return '';
}
function checksMarkup(state) {
  const { checks, failures, unknown } = checkCounts(state);
  if (!checks.length) return '';
  return '<details class="sim-checks"><summary class="'+(failures?'sim-check-fail':unknown?'sim-check-unknown':'')+'" title="Checks of this state only; does not verify every possible behavior.">'+(failures?amount(failures)+' failed · ':'')+'checks '+amount(checks.length)+'</summary><ul>'+checks.map(check => {
    const kind = check.holds===true?'pass':check.holds===false?'fail':'unknown';
    const status = check.holds===true?'holds':check.holds===false?'FAILED':'unchecked';
    return '<li class="sim-check-'+kind+'"><code>'+escapeHtml(check.name)+'</code><span>'+status+'</span>'+(check.error?'<pre>'+escapeHtml(check.error)+'</pre>':'')+'</li>';
  }).join('')+'</ul></details>';
}
function getPanelState(panel, session, currentKey, currentStep) {
  let local = panelStates.get(panel);
  if (!local || local.session!==session || local.currentKey!==currentKey || local.currentStep!==currentStep) {
    const samePosition = local && local.currentKey===currentKey && local.currentStep===currentStep;
    local={session,currentKey,currentStep,initialLimit:samePosition?local.initialLimit:30,transitionLimit:samePosition?local.transitionLimit:30,previewInitial:samePosition?local.previewInitial:0};
    panelStates.set(panel,local);
  }
  return local;
}
function toolbar(context, session) {
  const rootModule=session?.rootModule||context.rootModule||'';
  const startLabel=context.busy?'Evaluating…':'Init';
  return '<div class="sim-toolbar"><span class="sim-model-name" title="'+escapeHtml(rootModule)+'">'+escapeHtml(rootModule||'trace')+'</span><div class="sim-toolbar-buttons">'+
    (session?'<button data-sim-restart aria-label="'+(context.dirty?'Apply changes &amp; restart':'Restart from Init')+'" '+(context.busy||!context.canStart?'disabled':'')+'>'+(context.dirty?'Apply changes &amp; restart':'Restart')+'</button>':'<button data-sim-start aria-label="Start from Init" '+(!context.canStart||context.busy||context.dirty?'disabled':'')+'>'+startLabel+'</button>')+
    '<button data-sim-config aria-label="Edit configuration" '+(context.busy?'disabled':'')+'>Config</button>'+
    (context.busy?'<button class="sim-cancel-button" data-sim-cancel>Cancel</button>':'')+
    '</div><span class="sim-scope" title="Explore a chosen finite behavior. State invariant checks do not establish exhaustive safety or verify temporal properties.">interactive / not exhaustive</span></div>';
}
function noticesMarkup(context, session) {
  const warnings=Array.isArray(session?.warnings)?session.warnings.filter(item=>typeof item==='string'):[];
  return (context.dirty?'<div class="sim-dirty" role="status">Config changed · apply changes &amp; restart to continue.</div>':'')+
    (context.error?'<div class="sim-error" role="alert">'+escapeHtml(typeof context.error==='string'?context.error:context.error.message||'Trace evaluation failed.')+'</div>':'')+
    (warnings.length?'<details class="sim-warnings"><summary>warnings '+amount(warnings.length)+'</summary><ul>'+warnings.map(warning=>'<li>'+escapeHtml(warning)+'</li>').join('')+'</ul></details>':'');
}
function timelineMarkup(steps, currentStep, disabled) {
  if (!steps.length) return '';
  return '<nav class="sim-timeline" aria-label="Chosen trace steps">'+steps.map((step,index)=>
    (index?'<span class="sim-timeline-arrow" aria-hidden="true">›</span>':'')+
    '<button class="sim-timeline-step '+(index===currentStep?'active':'')+'" data-sim-step="'+index+'" aria-label="Go to step '+index+'" title="'+escapeHtml(index===0?'Init':step.action||'Next')+'" '+(index===currentStep?'aria-current="step"':'')+' '+(disabled?'disabled':'')+'><span class="sim-step-number">'+index+'</span><span class="sim-step-label">'+escapeHtml(index===0?'Init':step.action||'Next')+'</span></button>'
  ).join('')+'</nav>';
}
function statePane(state, title) {
  return '<section class="sim-state-column" aria-label="State"><div class="sim-pane-heading"><span>'+escapeHtml(title)+'</span>'+checksMarkup(state)+'</div><div class="sim-state-view" data-sim-state-view></div></section>';
}
function entryMarkup(context) {
  return '<div class="sim-entry"><code>{}</code><span>'+(context.busy?'Evaluating Init…':context.canStart?'Run Init to choose a state.':'Select .tla modules and a .cfg to evaluate Init.')+'</span>'+
    (typeof context.onUseRecordedTrace==='function'&&context.graph?'<button data-sim-recorded>Recorded trace →</button>':'')+'</div>';
}
function initialMarkup(context, session, local) {
  const initialStates=Array.isArray(session.initialStates)?session.initialStates:[];
  if (!initialStates.length) return '<div class="sim-empty">'+(context.busy?'Evaluating Init…':'Init returned no states. Check Init or Config, then restart.')+'</div>';
  local.previewInitial=Math.min(initialStates.length-1,Math.max(0,local.previewInitial));
  const current=initialStates[local.previewInitial];
  return '<div class="sim-workspace">'+statePane(current,'Init #'+amount(local.previewInitial+1))+'<section class="sim-outcomes-column" aria-label="Initial states"><div class="sim-pane-heading"><span>Init · '+amount(initialStates.length)+'</span><span class="sim-muted">select to inspect</span></div><div class="sim-choice-list">'+initialStates.slice(0,local.initialLimit).map((state,index)=>
    '<div class="sim-initial-row '+(index===local.previewInitial?'active':'')+'"><button class="sim-initial-preview" data-sim-preview-initial="'+index+'" aria-label="Inspect initial state '+(index+1)+'" '+(index===local.previewInitial?'aria-pressed="true"':'aria-pressed="false"')+'><span>Init #'+amount(index+1)+'</span>'+checkFlag(state)+'</button><button class="sim-initial-choose" data-sim-initial="'+index+'" aria-label="Start from initial state '+(index+1)+'" '+(context.busy||context.dirty?'disabled':'')+'>Start →</button></div>'
  ).join('')+'</div>'+(initialStates.length>local.initialLimit?moreMarkup('initial',local.initialLimit,initialStates.length,context.busy):'')+'</section></div>';
}
function moreMarkup(kind, limit, total, disabled) {
  return '<div class="sim-more"><span>'+amount(Math.min(limit,total))+' / '+amount(total)+'</span><button data-sim-more-'+kind+' '+(disabled?'disabled':'')+' aria-label="Show 30 more '+(kind==='initial'?'initial states':'outcomes')+'">More 30 ↓</button></div>';
}
function unavailableMarkup(context, session) {
  if(context.busy||context.error) return '';
  const diagnostics=Array.isArray(session.actionDiagnostics)?session.actionDiagnostics:[];
  const unavailable=diagnostics.filter(item=>item&&item.status!=='available'&&typeof item.action==='string');
  const truncated=session.actionDiagnosticsTruncated===true;
  if(!unavailable.length&&!truncated) return '';
  const statuses={blocked:'false guard',filtered:'constraint filtered','no-outcomes':'no outcomes',unknown:'unknown'};
  return '<details class="sim-unavailable" open><summary'+(truncated?' title="Diagnostic enumeration reached its limit for this state. Other unavailable action instances may be omitted."':'')+'>Unavailable <span>'+amount(unavailable.length)+(truncated?' shown':'')+'</span></summary>'+unavailable.map((item,index)=>{
    const guards=Array.isArray(item.guards)?item.guards.filter(guard=>guard&&typeof guard.expression==='string'):[];
    const parameters=Array.isArray(item.parameters)?item.parameters.filter(parameter=>parameter&&typeof parameter.name==='string'):[];
    const bindings=parameters.map(parameter=>parameter.name+' = '+String(parameter.value??'')).join(', ');
    const label=item.action+(bindings?'('+bindings+')':'');
    const status=statuses[item.status]||'unknown';
    const reason=typeof item.reason==='string'?item.reason:'';
    const explanation=item.status==='filtered'?'Generated outcomes were excluded by model constraints.':item.status==='no-outcomes'?'No successor states were generated; passing guards alone do not establish that an action is enabled.':item.status==='unknown'?'Evaluation did not establish whether this action has an enabled outcome.':'';
    return '<details class="sim-unavailable-action" data-sim-unavailable="'+index+'"><summary title="'+escapeHtml(label+' · '+status)+'"><span class="sim-unavailable-name">'+escapeHtml(label)+'</span><span class="sim-unavailable-status sim-guard-'+(item.status==='blocked'?'false':item.status==='unknown'?'unknown':'neutral')+'">'+status+'</span></summary><div class="sim-guard-detail">'+
      (bindings?'<div class="sim-guard-bindings"><span>parameters</span><code>'+escapeHtml(bindings)+'</code></div>':'')+
      (guards.length?'<div class="sim-guard-heading" title="Expressions rendered by the browser engine from the parsed action; statuses are actual evaluation results for this state and parameter instance.">evaluated guards</div><div class="sim-guard-list">'+guards.map(guard=>{
        const holds=guard.holds===true?'true':guard.holds===false?'false':'unknown';
        return '<div class="sim-guard-row sim-guard-'+holds+'"><span class="sim-guard-result">'+holds+'</span><pre>'+escapeHtml(guard.expression)+'</pre>'+(guard.error?'<pre class="sim-guard-error">'+escapeHtml(guard.error)+'</pre>':'')+'</div>';
      }).join('')+'</div>':'<div class="sim-guard-note">No evaluated standalone guards returned.</div>')+
      (reason?'<div class="sim-guard-note">'+escapeHtml(reason)+'</div>':explanation?'<div class="sim-guard-note">'+explanation+'</div>':'')+
      (item.status==='filtered'?'<div class="sim-guard-count">generated '+amount(item.generatedCount)+' · available '+amount(item.availableCount)+'</div>':'')+
      '</div></details>';
  }).join('')+'</details>';
}
function availableMarkup(context, session, local, currentStep, stepCount) {
  const available=Array.isArray(session.available)?session.available:[];
  let content;
  if (context.busy) content='<div class="sim-working" role="status">Evaluating actions…</div>';
  else if (context.error) content='<div class="sim-empty">Action evaluation failed. Restart or edit Config.</div>';
  else if (!available.length) content='<div class="sim-empty">No enabled outcomes.'+(session.warnings?.length?' See warnings.':'')+'</div>';
  else content='<div class="sim-choice-list">'+available.slice(0,local.transitionLimit).map((transition,index)=>{
    const changes=Array.isArray(transition.changes)?transition.changes:[];
    const names=changes.map(change=>change.name).filter(name=>typeof name==='string');
    const changeLabel=names.length?names.join(', '):'unchanged';
    const action=transition.action||'Next';
    return '<div class="sim-action-row"><button class="sim-action-choose" data-sim-transition="'+index+'" aria-label="Choose '+escapeHtml(action)+' option '+(index+1)+'" title="'+escapeHtml(action+' · '+changeLabel)+'" '+(context.busy||context.dirty?'disabled':'')+'><span class="sim-action-name">'+escapeHtml(action)+'</span><span class="sim-action-changes">'+escapeHtml(changeLabel)+'</span>'+checkFlag(transition.to)+'<span class="sim-action-arrow" aria-hidden="true">→</span></button><details class="sim-action-diff" data-sim-diff="'+index+'"><summary aria-label="Inspect changes for '+escapeHtml(action)+' option '+(index+1)+'" title="Inspect changes">Δ</summary><div class="sim-diff-view" data-sim-diff-view></div></details></div>';
  }).join('')+'</div>';
  return '<section class="sim-outcomes-column" aria-label="Actions"><div class="sim-pane-heading"><span>enabled · '+amount(available.length)+'</span>'+(currentStep<stepCount-1?'<span class="sim-branch-note" title="Choosing an action replaces the later steps with this branch.">branch at '+amount(currentStep)+'</span>':'')+'</div><div class="sim-action-scroll">'+content+'</div>'+
    (!context.busy&&available.length>local.transitionLimit?moreMarkup('transition',local.transitionLimit,available.length,false):'')+unavailableMarkup(context,session)+'</section>';
}

/** Render only passed browser-memory data. No network, storage or evaluation. */
export function renderTraceSimulator(panel, context={}) {
  const session=context.session||null;
  const steps=Array.isArray(session?.steps)?session.steps:[];
  const currentStep=steps.length?Math.min(steps.length-1,Math.max(0,Number.isInteger(context.currentStep)?context.currentStep:steps.length-1)):0;
  const current=steps[currentStep]?.state||null;
  const local=getPanelState(panel,session,current?.key||'',currentStep);
  const disabled=Boolean(context.busy||context.dirty);
  let body;
  if (!session) body=entryMarkup(context);
  else if (!steps.length) body=initialMarkup(context,session,local);
  else body='<div class="sim-workspace">'+statePane(current,'state · '+amount(currentStep)) + availableMarkup(context,session,local,currentStep,steps.length)+'</div>';
  panel.classList.add('trace-simulator-panel');
  panel.innerHTML='<div class="sim-shell">'+toolbar(context,session)+timelineMarkup(steps,currentStep,disabled)+noticesMarkup(context,session)+'<div class="sim-body">'+body+'</div></div>';
  const stateView=panel.querySelector('[data-sim-state-view]');
  const preview=!steps.length?session?.initialStates?.[local.previewInitial]:current;
  if(stateView) renderStateView(stateView,{variables:preview?.variables||{},previous:currentStep?steps[currentStep-1]?.state?.variables:undefined,mode:'all',idPrefix:'sim-state',controls:true});
  const bind=(selector,callback,valueOf)=>panel.querySelectorAll(selector).forEach(button=>button.addEventListener('click',()=>invoke(context,callback,...(valueOf?[valueOf(button)]:[]))));
  bind('[data-sim-start]','onStart');bind('[data-sim-config]','onOpenConfig');bind('[data-sim-restart]','onRestart');bind('[data-sim-cancel]','onCancel');bind('[data-sim-recorded]','onUseRecordedTrace');
  bind('[data-sim-initial]','onChooseInitial',button=>Number(button.dataset.simInitial));
  bind('[data-sim-transition]','onChooseTransition',button=>Number(button.dataset.simTransition));
  bind('[data-sim-step]','onSelectStep',button=>Number(button.dataset.simStep));
  panel.querySelectorAll('[data-sim-preview-initial]').forEach(button=>button.addEventListener('click',()=>{local.previewInitial=Number(button.dataset.simPreviewInitial);renderTraceSimulator(panel,context);}));
  panel.querySelector('[data-sim-more-initial]')?.addEventListener('click',()=>{local.initialLimit+=30;renderTraceSimulator(panel,context);});
  panel.querySelector('[data-sim-more-transition]')?.addEventListener('click',()=>{local.transitionLimit+=30;renderTraceSimulator(panel,context);});
  panel.querySelectorAll('[data-sim-diff]').forEach(details=>details.addEventListener('toggle',()=>{
    if(!details.open||details.dataset.rendered) return;
    const transition=session?.available?.[Number(details.dataset.simDiff)];
    renderStateView(details.querySelector('[data-sim-diff-view]'),{variables:transition?.to?.variables||{},previous:current?.variables||{},mode:'changes',idPrefix:'sim-diff-'+details.dataset.simDiff,controls:false});
    details.dataset.rendered='true';
  }));
  const activeStep=panel.querySelector('[aria-current="step"]');
  activeStep?.scrollIntoView?.({block:'nearest',inline:'nearest'});
}
