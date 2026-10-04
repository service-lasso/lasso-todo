import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const [serviceDirectory, mode] = process.argv.slice(2);
if (!serviceDirectory || !['json', 'postgres', 'api'].includes(mode)) throw new Error('Use configure-stage.mjs <installed-todo-directory> json|postgres|api; stop Todo first.');
const root = path.resolve(serviceDirectory);
const manifestPath = path.join(root, 'service.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== 'todo' || manifest.artifact?.source?.repo !== 'service-lasso/lasso-todo') throw new Error('Expected the installed lasso-todo manifest; no files changed.');
if (mode !== 'json') await access(path.join(root, '..', mode === 'postgres' ? 'postgres' : 'todo-api', 'service.json'));
manifest.depend_on = ['@node', ...(mode === 'json' ? [] : [mode === 'postgres' ? 'postgres' : 'todo-api']), ...(manifest.env.TODO_OIDC_ISSUER ? ['zitadel'] : [])];
delete manifest.env.TODO_DATABASE_STATE; delete manifest.env.TODO_API_STATE;
if (mode === 'postgres') manifest.env.TODO_DATABASE_STATE = '${SERVICE_ROOT}/../postgres/.state/runtime.json';
if (mode === 'api') manifest.env.TODO_API_STATE = '${SERVICE_ROOT}/../todo-api/.state/runtime.json';
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Todo mode ${mode} configured. Reload Lasso discovery and start through Admin. Existing data is retained.`);
