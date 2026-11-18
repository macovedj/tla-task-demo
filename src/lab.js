const VERSION = 1;
const origin = window.location.origin;
const rootUrl = new URL('../', import.meta.url);
const appFrame = document.getElementById('app-frame');
const viewerFrame = document.getElementById('viewer-frame');
const status = document.getElementById('connection-status');
const statusRow = status.parentElement;
const projectInput = document.getElementById('edit-project-input');
const projectError = document.getElementById('project-error');
const frames = [
  { frame: appFrame, name: 'app', ready: false, loaded: false },
  { frame: viewerFrame, name: 'viewer', ready: false, loaded: false },
];
let files = null;
let manifest = null;
let connection = null;
let retired = false;
let disposed = false;
let readyTimer;
let loadingError = null;
const loading = new AbortController();

function show(message, state = 'waiting') {
  status.textContent = message;
  statusRow.dataset.state = state;
}
function editProject(input) {
  if (!input.trim()) return null;
  const url = new URL(input);
  if (url.origin !== 'https://edit-test.dev' || !/^\/p\/[A-Za-z0-9_-]{1,100}\/?$/.test(url.pathname) || url.username || url.password) throw new Error('Use an https://edit-test.dev/p/… project URL.');
  url.hash = '';
  return url.href;
}
let editProjectUrl = null;
projectInput.value = new URLSearchParams(location.search).get('project') || '';
try {
  editProjectUrl = editProject(projectInput.value);
} catch { projectError.textContent = 'Use an https://edit-test.dev/p/… project URL. Source links are disabled.'; projectError.hidden = false; }

function post(frame, message, ports = []) {
  if (!frame.contentWindow) throw new Error('A preview frame is not available.');
  frame.contentWindow.postMessage(message, origin, ports);
}
function disconnect(reason) {
  const previous = connection;
  connection = null;
  if (!previous) return;
  retired = true;
  for (const item of frames) item.ready = false;
  for (const { frame, name } of frames) {
    try { post(frame, { type: `tla-${name}-disconnect`, version: VERSION, session: previous.session, reason }); } catch { /* Reloaded or closed. */ }
  }
}
function update() {
  if (disposed) return;
  if (loadingError) { show(loadingError, 'error'); return; }
  if (retired) { show('Connection closed. Use Reload connection to restore both panes.', 'error'); return; }
  if (!files || !manifest) { show('Loading the project model and bindings…'); return; }
  const waiting = frames.filter(item => !item.ready || !item.loaded).map(item => item.name);
  if (waiting.length) { show(`Waiting for the ${waiting.join(' and ')} pane${waiting.length > 1 ? 's' : ''}…`); return; }
  if (connection) return;
  const session = crypto.randomUUID();
  const channel = new MessageChannel();
  connection = { session };
  try {
    post(appFrame, { type: 'tla-app-connect', version: VERSION, session }, [channel.port1]);
    post(viewerFrame, { type: 'tla-viewer-connect', version: VERSION, session, manifest, files, ...(editProjectUrl ? { editProjectUrl } : {}) }, [channel.port2]);
    clearTimeout(readyTimer);
    show('Connected · model actions now drive the running app.', 'ready');
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    disconnect('The channel could not be established.');
    show(error.message, 'error');
  }
}
function readinessDeadline() {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (disposed || connection || loadingError) return;
    const missing = frames.filter(item => !item.ready).map(item => item.name).join(' and ');
    show(missing ? `The ${missing} pane did not become ready. Check that the viewer bundle is present, then reload both.` : 'The project model did not finish loading.', 'error');
  }, 20000);
}
function receive(event) {
  if (disposed || event.origin !== origin || !event.data || event.data.version !== VERSION) return;
  const item = frames.find(item => item.frame.contentWindow === event.source);
  if (!item) return;
  if (event.data.type === `tla-${item.name}-ready`) {
    item.ready = true;
    update();
  } else if (event.data.type === `tla-${item.name}-disconnected` && event.data.session === connection?.session) {
    disconnect('A linked pane disconnected.');
    item.ready = false;
    show('A linked pane disconnected. Reload both to reconnect.', 'error');
  }
}
window.addEventListener('message', receive);
for (const item of frames) {
  item.frame.addEventListener('load', () => {
    if (disposed) return;
    disconnect('A linked pane was loaded or reloaded.');
    item.loaded = true;
    item.ready = false;
    show(`Connecting the ${item.name} pane…`);
    post(item.frame, { type: `tla-${item.name}-probe`, version: VERSION });
    readinessDeadline();
    update();
  });
}
function launch() {
  disconnect('Both panes are being reloaded.');
  retired = false;
  for (const item of frames) { item.ready = false; item.loaded = false; }
  show('Loading the app and viewer…');
  appFrame.src = new URL('index.html?bridge=parent', rootUrl).href;
  viewerFrame.src = new URL('viewer/linked-app.html?bridge=parent', rootUrl).href;
  readinessDeadline();
}
document.getElementById('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    editProjectUrl = editProject(projectInput.value);
    projectError.hidden = true;
    launch();
  } catch {
    projectError.textContent = 'Use an https://edit-test.dev/p/… project URL, or leave it empty.';
    projectError.hidden = false;
  }
});

function projectPath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('The binding manifest contains an invalid model path.');
  const url = new URL(path, rootUrl);
  if (url.origin !== origin || !url.pathname.startsWith(rootUrl.pathname)) throw new Error('The model path must stay inside this project.');
  return url;
}
async function readText(url, maxBytes) {
  const response = await fetch(url, { cache: 'no-store', signal: loading.signal });
  if (!response.ok) throw new Error(`Could not load ${url.pathname} (${response.status}).`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error('A project model file exceeds the demo size limit.');
  return text;
}
const loadTimeout = setTimeout(() => loading.abort(), 20000);
async function loadProject() {
  try {
    manifest = JSON.parse(await readText(new URL('tla-bindings.json', rootUrl), 65536));
    if (!manifest || manifest.version !== VERSION || !manifest.model) throw new Error('The binding manifest version is not supported.');
    const paths = [manifest.model.module, manifest.model.config];
    const urls = paths.map(projectPath);
    files = await Promise.all(urls.map(async (url, index) => {
      const name = paths[index].split('/').at(-1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*\.(tla|cfg)$/.test(name)) throw new Error('The model needs simple .tla and .cfg filenames.');
      return { name, content: await readText(url, 1024 * 1024) };
    }));
    if (!files[0].name.endsWith('.tla') || !files[1].name.endsWith('.cfg')) throw new Error('The model manifest needs a .tla module and a .cfg configuration.');
    update();
  } catch (error) {
    if (disposed) return;
    loadingError = error.name === 'AbortError' ? 'Loading the project files timed out. Reload the lab to try again.' : error.message;
    show(loadingError, 'error');
  } finally { clearTimeout(loadTimeout); }
}
window.addEventListener('pagehide', () => {
  disconnect('The lab page was closed or reloaded.');
  disposed = true;
  loading.abort();
  clearTimeout(readyTimer);
  clearTimeout(loadTimeout);
  window.removeEventListener('message', receive);
}, { once: true });
launch();
void loadProject();
