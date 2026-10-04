import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const [directory, mode, issuerValue, clientId] = process.argv.slice(2);
if (!directory || !['enable', 'disable'].includes(mode)) throw Error('Stop Todo, then use configure-sso.mjs <installed-todo-directory> enable <https-issuer> <client-id> | disable.');
const root = path.resolve(directory), file = path.join(root, 'service.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
if (manifest.id !== 'todo' || manifest.artifact?.source?.repo !== 'service-lasso/lasso-todo') throw Error('Expected installed lasso-todo; no files changed.');
if (mode === 'enable') {
  const issuer = new URL(issuerValue);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.pathname !== '/' || issuer.search || issuer.hash || !clientId || clientId.length > 256 || /\s/.test(clientId)) throw Error('Use HTTPS issuer origin and public Web client ID.');
  await access(path.join(root, '..', 'zitadel', 'service.json'));
  manifest.env.TODO_OIDC_ISSUER = issuer.origin;
  manifest.env.TODO_OIDC_CLIENT_ID = clientId;
  manifest.env.TODO_ORIGIN = 'http://127.0.0.1:${endpoint.web.port}';
  manifest.depend_on = [...new Set([...(manifest.depend_on ?? []), 'zitadel'])];
} else {
  for (const key of ['TODO_OIDC_ISSUER', 'TODO_OIDC_CLIENT_ID', 'TODO_ORIGIN']) delete manifest.env[key];
  manifest.depend_on = (manifest.depend_on ?? []).filter(id => id !== 'zitadel');
}
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Todo sign-in ${mode}d; storage settings and data preserved. Refresh Lasso and start Todo.`);
