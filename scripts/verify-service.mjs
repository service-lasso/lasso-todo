import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = JSON.parse(await readFile(path.join(root, 'service-build.json'), 'utf8'));
const platform = process.platform;
await mkdir(path.join(root, '.tmp'), { recursive: true });
const consumer = await mkdtemp(path.join(root, '.tmp', 'consumer-'));
const archive = path.join(root, 'dist', `${build.name}-${platform}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex');
const extract = platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:LASSO_PACKAGE_ARCHIVE, $env:LASSO_PACKAGE_CONSUMER)'], { env: { ...process.env, LASSO_PACKAGE_ARCHIVE: archive, LASSO_PACKAGE_CONSUMER: consumer }, windowsHide: true })
  : spawnSync('tar', ['-xzf', archive, '-C', consumer], { windowsHide: true });
if (extract.error || extract.status !== 0) throw new Error('Archive extraction failed');
if (build.kind !== 'node') throw new Error('Go API requires the managed PostgreSQL consumer gate; use verify-managed-api.mjs');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const file = path.join(consumer, 'data', 'todos.json');
let child, closed;
const start = async () => {
  child = spawn(process.execPath, [path.join(consumer, 'runtime', 'server.mjs')], {
    cwd: consumer, env: { ...process.env, TODO_PORT: String(port), TODO_DATA_FILE: file, TODO_DATABASE_STATE: '', TODO_API_STATE: '', TODO_OIDC_ISSUER: '', TODO_OIDC_CLIENT_ID: '', TODO_ORIGIN: '' }, windowsHide: true, stdio: 'pipe'
  });
  closed = once(child, 'close');
  let logs = ''; child.stderr.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Packaged service exited: ' + logs);
    try { if ((await fetch(url + '/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Packaged HTTP readiness timeout');
};
const stop = async () => { child.kill(); await closed; child = undefined; };
try {
  await start();
  assert.equal((await fetch(url)).status, 200);
  const post = title => fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
  assert.equal((await post('')).status, 400);
  const created = await post('archive consumer retained todo'); assert.equal(created.status, 201);
  const todo = await created.json();
  await stop(); await start();
  assert.deepEqual(await (await fetch(url + '/todos')).json(), [todo]);
  await mkdir(path.join(root, 'output'), { recursive: true });
  await writeFile(path.join(root, 'output', 'package-verification.json'), JSON.stringify({ platform, archiveHash, todoId: todo.id, http: 'passed', restartPersistence: 'passed', boundary: 'archive consumer; Core managed lifecycle verified separately' }, null, 2) + '\n');
  console.log('Fresh packaged Todo HTTP, invalid-input and restart persistence passed');
} finally { if (child) await stop(); }
const ssoCheck = spawnSync(process.execPath, ['--test', path.join(root, 'tests/todo-sso.test.mjs')], { env: { ...process.env, SSO_RUNTIME_ROOT: consumer }, stdio: 'inherit', windowsHide: true });
if (ssoCheck.error || ssoCheck.status !== 0) throw Error('Packaged OIDC consumer protocol verification failed');
