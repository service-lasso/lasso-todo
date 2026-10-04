import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const [directory, mode, issuerValue, clientId, projectId, apiClientId, secretFile, caFile] = process.argv.slice(2);
if (!directory || !['enable', 'disable'].includes(mode)) throw Error('Stop Todo and the API, then use configure-sso.mjs <installed-todo-directory> enable <https-issuer> <web-client-id> <project-id> <api-client-id> <private-secret-file> [public-ca-file] | disable.');
const root = path.resolve(directory), file = path.join(root, 'service.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
if (manifest.id !== 'todo' || manifest.artifact?.source?.repo !== 'service-lasso/lasso-todo') throw Error('Expected installed lasso-todo; no files changed.');
let apiManifest, apiFile = path.join(root, '..', 'todo-api', 'service.json');
if (manifest.env.TODO_API_STATE) {
  try { apiManifest = JSON.parse(await readFile(apiFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || projectId || apiClientId || secretFile) throw error; }
  const apiContract = apiManifest?.env?.TODO_API_AUTH_CONTRACT ?? apiManifest?.meta?.apiAuthContract;
  if (apiManifest && (apiManifest.id !== 'todo-api' || apiContract !== 'zitadel-introspection-v1')) throw Error('Upgrade the API to the secured introspection consumer first; no changes.');
}
if (mode === 'enable') {
  const issuer = new URL(issuerValue);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.pathname !== '/' || issuer.search || issuer.hash || !clientId || clientId.length > 256 || /\s/.test(clientId)) throw Error('Use HTTPS issuer origin and public Web client ID.');
  await access(path.join(root, '..', 'zitadel', 'service.json'));
  if (apiManifest && (!projectId || !apiClientId || !secretFile)) throw Error('Stop both services and supply project ID, API client ID and private credential file; no changes.');
  if (projectId || apiClientId || secretFile) {
    if (!apiManifest || !projectId || !apiClientId || !secretFile || [projectId,apiClientId].some(value => value.length > 256 || /[\s${}]/.test(value))) throw Error('API mode requires project ID, API client ID and private credential file; no changes.');
    await access(path.resolve(secretFile)); if (caFile) await access(path.resolve(caFile));
    Object.assign(apiManifest.env, { TODO_API_AUTH_MODE: 'zitadel', TODO_OIDC_ISSUER: issuer.origin, TODO_OIDC_AUDIENCE: projectId, TODO_OIDC_CLIENT_ID: clientId, TODO_API_CLIENT_ID: apiClientId, TODO_API_CLIENT_SECRET_FILE: path.resolve(secretFile) });
    manifest.env.TODO_OIDC_AUDIENCE = projectId;
    if (caFile) { apiManifest.env.TODO_API_CA_FILE = path.resolve(caFile); manifest.env.NODE_EXTRA_CA_CERTS = path.resolve(caFile); }
    apiManifest.depend_on = [...new Set([...(apiManifest.depend_on ?? []), 'zitadel'])];
  }
  manifest.env.TODO_OIDC_ISSUER = issuer.origin;
  manifest.env.TODO_OIDC_CLIENT_ID = clientId;
  manifest.env.TODO_ORIGIN = 'http://127.0.0.1:${endpoint.web.port}';
  manifest.depend_on = [...new Set([...(manifest.depend_on ?? []), 'zitadel'])];
} else {
  for (const key of ['TODO_OIDC_ISSUER', 'TODO_OIDC_CLIENT_ID', 'TODO_ORIGIN', 'TODO_OIDC_AUDIENCE']) delete manifest.env[key];
  manifest.depend_on = (manifest.depend_on ?? []).filter(id => id !== 'zitadel');
  if (apiManifest) {
    for (const key of ['TODO_OIDC_ISSUER','TODO_OIDC_AUDIENCE','TODO_OIDC_CLIENT_ID','TODO_API_CLIENT_ID','TODO_API_CLIENT_SECRET_FILE','TODO_API_CA_FILE']) delete apiManifest.env[key];
    apiManifest.env.TODO_API_AUTH_MODE = 'anonymous'; apiManifest.depend_on = (apiManifest.depend_on ?? []).filter(id => id !== 'zitadel');
  }
}
// Update API first: interruption leaves the app blocked, never an unprotected API behind a signed-in app.
if (apiManifest) await writeFile(apiFile, JSON.stringify(apiManifest, null, 2) + '\n');
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Todo sign-in ${mode}d; storage settings and data preserved. Refresh Lasso and start Todo.`);
if (mode === 'enable' && manifest.env.TODO_API_STATE && !projectId) console.log('Legacy app-only configuration staged. API-mode startup stays blocked until you supply project ID, API client ID and private secret file.');
