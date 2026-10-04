import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const port = Number(process.env.TODO_PORT);
const file = process.env.TODO_DATA_FILE;
if (!file || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Launch through Service Lasso with TODO_PORT and TODO_DATA_FILE.');
}
await mkdir(path.dirname(file), { recursive: true });
let todos;
try { todos = JSON.parse(await readFile(file, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; todos = []; }
if (!Array.isArray(todos)) throw new Error('Invalid Todo data; preserve the file and inspect it.');
const html = await readFile(new URL('./index.html', import.meta.url));
let database;
if (process.env.TODO_DATABASE_STATE) {
  const { openDatabase } = await import('./database.mjs');
  database = await openDatabase(process.env.TODO_DATABASE_STATE);
  await database.seed(todos);
}
let api;
if (process.env.TODO_API_STATE) {
  const state = JSON.parse(await readFile(process.env.TODO_API_STATE, 'utf8'));
  const apiPort = state.ports?.web;
  if (!Number.isInteger(apiPort) || apiPort < 1) throw new Error('Start the Go API through Lasso first.');
  api = `http://127.0.0.1:${apiPort}`;
}
let writes = Promise.resolve();
const server = createServer(async (request, response) => {
  const send = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      if (database) await database.health();
      if (api) { const health = await fetch(api + '/healthz', { signal: AbortSignal.timeout(5000) }); if (!health.ok) throw new Error('API unavailable'); }
      return send(200, { status: 'ok' });
    }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(html);
    }
    if (request.method === 'GET' && request.url === '/todos') {
      if (api) { const result = await fetch(api + '/todos', { signal: AbortSignal.timeout(5000) }); return send(result.status, await result.json()); }
      return send(200, database ? await database.list() : todos);
    }
    if (request.method !== 'POST' || request.url !== '/todos') return send(404, { error: 'Not found' });
    if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
    if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`) return send(403, { error: 'Use this app origin' });
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) return send(413, { error: 'Request too large' });
    }
    let input;
    try { input = JSON.parse(body); } catch { return send(400, { error: 'Invalid JSON' }); }
    if (typeof input?.title !== 'string' || !input.title.trim() || input.title.length > 200) return send(400, { error: 'Enter a title of 1–200 characters' });
    if (api) {
      const result = await fetch(api + '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
      return send(result.status, await result.json());
    }
    const todo = { id: randomUUID(), title: input.title.trim() };
    const write = writes.then(async () => {
      if (database) { await database.add(todo); return; }
      if (todos.length >= 1000) { const error = new Error('Todo limit reached'); error.limit = true; throw error; }
      const next = [...todos, todo];
      await writeFile(file + '.tmp', JSON.stringify(next) + '\n');
      await rename(file + '.tmp', file);
      todos = next;
    });
    writes = write.catch(() => {});
    await write;
    send(201, todo);
  } catch (error) {
    const unavailable = api ? 'Go Todo API unavailable' : database ? 'PostgreSQL unavailable' : 'Storage unavailable';
    console.error(error.limit ? 'Todo limit reached' : `${unavailable}; check the dependency or data access in Admin.`);
    send(error.limit ? 409 : api || database ? 503 : 500, { error: error.limit ? 'Todo limit reached' : unavailable });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Todo app ready at http://127.0.0.1:${port}/`));
const stop = () => server.close(() => writes.finally(async () => { await database?.close(); process.exit(0); }));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
