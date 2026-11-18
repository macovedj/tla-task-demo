import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source) throw new Error('Usage: npm run vendor:viewer -- /path/to/tlaviewer');
const viewerSource = resolve(source);
const output = fileURLToPath(new URL('../viewer/', import.meta.url));
const webFiles = ['linked-app.html', 'linked-app.mjs', 'linked-app.css', 'app-bridge.mjs', 'trace-simulator.mjs', 'trace-simulator.css', 'state-view.mjs', 'state-view.css', 'engine-client.mjs', 'engine-worker.mjs'];
const libraryFiles = ['app-conformance.mjs', 'browser-engine.mjs', 'tlc-graph.mjs'];
// Check all input files before replacing this generated directory.
await Promise.all([...webFiles.map(file => readFile(join(viewerSource, 'web', file))), ...libraryFiles.map(file => readFile(join(viewerSource, 'src', file)))]);
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'lib'), { recursive: true });
await mkdir(join(output, 'vendor'), { recursive: true });
for (const file of webFiles) await cp(join(viewerSource, 'web', file), join(output, file));
for (const file of libraryFiles) await cp(join(viewerSource, 'src', file), join(output, 'lib', file));
await cp(join(viewerSource, 'web/vendor/tla-checker'), join(output, 'vendor/tla-checker'), { recursive: true });
const wasm = await readFile(join(output, 'vendor/tla-checker/tla_checker_bg.wasm'));
await writeFile(join(output, 'vendor/tla-checker/wasm-bytes.mjs'), '// Bundled WASM; the model checker makes no network requests.\nconst base64=' + JSON.stringify(wasm.toString('base64')) + ';\nexport default Uint8Array.from(atob(base64),character=>character.charCodeAt(0));\n');

const files = {};
async function inventory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else files[relative(output, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await inventory(output);
await writeFile(join(output, 'BUNDLE.json'), JSON.stringify({ source: 'TLA+ State Explorer', mode: 'linked application', sha256: files }, null, 2) + '\n');
await writeFile(join(output, 'README.md'), '# Bundled TLA+ linked viewer\n\nGenerated with `npm run vendor:viewer -- /path/to/tlaviewer`.\nOpen `../lab.html` as an Edit file preview to connect the live app.\nThe viewer reuses the state explorer\'s trace UI and browser WASM checker.\n`BUNDLE.json` records content hashes. Engine provenance and licenses are in\n`vendor/tla-checker/`.\n');
console.log(`Packaged ${Object.keys(files).length} viewer assets; model execution stays browser-local.`);
