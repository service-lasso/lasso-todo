import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));

test('managed Todo example rejects invalid writes and keeps data across process restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lasso-todo-example-'));
  const file = path.join(root, 'data/todos.json');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  let child;
  let closed;
  const start = async () => {
    child = spawn(process.execPath, [source], {
      env: { ...process.env, TODO_PORT: String(port), TODO_DATA_FILE: file, TODO_DATABASE_STATE: '', TODO_API_STATE: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    closed = once(child, 'close');
    for (let i = 0; i < 100; i++) {
      try { const response = await fetch(url + '/healthz'); if (response.ok) return; } catch {}
      if (child.exitCode !== null) throw new Error('Todo process exited before ready');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Todo did not become ready');
  };
  const stop = async () => { child.kill(); await closed; child = undefined; };
  const post = body => fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    await start();
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({title: ' '}))).status, 400);
    assert.equal((await post(JSON.stringify({title: 'x'.repeat(201)}))).status, 400);
    assert.equal((await fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"title":"bad"}' })).status, 415);
    assert.equal((await fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body: '{"title":"bad"}' })).status, 403);
    const results = await Promise.all(['first', '<script>literal text</script>'].map(async title => {
      const response = await post(JSON.stringify({title}));
      assert.equal(response.status, 201);
      return response.json();
    }));
    assert.equal((await (await fetch(url + '/todos')).json()).length, 2);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2);
    await stop();
    await start();
    const saved = await (await fetch(url + '/todos')).json();
    assert.deepEqual(saved.sort((a, b) => a.id.localeCompare(b.id)), results.sort((a, b) => a.id.localeCompare(b.id)));
    const html = await (await fetch(url)).text();
    assert.match(html, /textContent = todo.title/);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
