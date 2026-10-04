import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('SSO signed protocol: protected data, PKCE/state/nonce/signature/claims, logout, restart and preserved storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lasso-todo-sso-'));
  const certificate = path.join(root, 'cert.pem'), key = path.join(root, 'key.pem');
  const opensslConfig = path.join(root, 'openssl.cnf');
  await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', opensslConfig], { windowsHide: true });
  assert.equal(generated.status, 0, 'Create isolated protocol fixture certificate');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const unrelated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  let mode = 'valid', issuer, tokenRequests = 0;
  const codes = new Map();
  const provider = https.createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    const url = new URL(request.url, issuer);
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/keys', end_session_endpoint: issuer + '/logout', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/keys') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      tokenRequests++;
      let body = ''; for await (const chunk of request) body += chunk;
      const input = new URLSearchParams(body), entry = codes.get(input.get('code'));
      codes.delete(input.get('code'));
      if (entry?.mode === 'outage') { response.writeHead(503); return response.end(); }
      if (!entry || createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== entry.challenge || input.get('redirect_uri') !== entry.redirect || input.get('client_id') !== 'todo-client') { response.writeHead(400); return response.end(); }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: 'todo-client', sub: 'fixture-user', name: '<b>Literal user</b>', nonce: entry.nonce, iat: now, exp: now + 600 };
      if (entry.mode === 'nonce') claims.nonce = 'bad';
      if (entry.mode === 'issuer') claims.iss = 'https://wrong.example';
      if (entry.mode === 'audience') claims.aud = 'other-client';
      if (entry.mode === 'expired') claims.exp = now - 600;
      const encoded = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      const signature = sign('RSA-SHA256', Buffer.from(encoded), entry.mode === 'signature' ? unrelated : privateKey).toString('base64url');
      return json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 600, id_token: encoded + '.' + signature });
    }
    response.writeHead(404); response.end();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  issuer = `https://127.0.0.1:${provider.address().port}`;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, file = path.join(root, 'todos.json');
  const original = { id: randomUUID(), title: 'retained original' }; await writeFile(file, JSON.stringify([original]));
  let child, closed;
  const start = async () => {
    child = spawn(process.execPath, [process.env.SSO_RUNTIME_ROOT ? path.join(process.env.SSO_RUNTIME_ROOT, 'runtime/server.mjs') : fileURLToPath(new URL('../runtime/server.mjs', import.meta.url))], { env: { ...process.env, TODO_PORT: String(port), TODO_DATA_FILE: file, TODO_DATABASE_STATE: '', TODO_API_STATE: '', TODO_OIDC_ISSUER: issuer, TODO_OIDC_CLIENT_ID: 'todo-client', TODO_ORIGIN: origin, NODE_EXTRA_CA_CERTS: certificate }, stdio: 'pipe', windowsHide: true });
    closed = once(child, 'close');
    for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/healthz')).ok) return; } catch {} if (child.exitCode !== null) throw Error('Consumer failed startup'); await new Promise(resolve => setTimeout(resolve, 30)); }
    throw Error('Consumer readiness timeout');
  };
  const stop = async () => { child.kill(); await closed; child = undefined; };
  const begin = async () => {
    const response = await fetch(origin + '/auth/login', { redirect: 'manual' });
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get('location'));
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const code = randomUUID();
    codes.set(code, { mode, nonce: authorize.searchParams.get('nonce'), challenge: authorize.searchParams.get('code_challenge'), redirect: authorize.searchParams.get('redirect_uri') });
    return { cookie: response.headers.get('set-cookie').split(';')[0], callback: origin + '/auth/callback?code=' + code + '&state=' + authorize.searchParams.get('state') };
  };
  try {
    await start();
    assert.equal((await fetch(origin + '/todos')).status, 401);
    assert.equal((await fetch(origin + '/todos', { method: 'POST' })).status, 401);
    assert.equal((await fetch(origin + '/auth/callback?code=unsolicited&state=x', { redirect: 'manual' })).headers.get('location'), origin + '/?signin=failed');
    for (const rejected of ['nonce', 'issuer', 'audience', 'signature', 'expired', 'outage']) {
      mode = rejected; const attempt = await begin();
      const response = await fetch(attempt.callback, { headers: { cookie: attempt.cookie }, redirect: 'manual' });
      assert.equal(response.headers.get('location'), origin + '/?signin=failed', rejected);
      assert.equal((await fetch(origin + '/todos')).status, 401);
    }
    mode = 'valid';
    const tampered = await begin(), count = tokenRequests;
    assert.equal((await fetch(tampered.callback + 'bad', { headers: { cookie: tampered.cookie }, redirect: 'manual' })).headers.get('location'), origin + '/?signin=failed');
    assert.equal(tokenRequests, count, 'Bad state rejected before token exchange');
    assert.equal((await fetch(tampered.callback, { headers: { cookie: tampered.cookie }, redirect: 'manual' })).headers.get('location'), origin + '/?signin=failed', 'Callback single use');
    const attempt = await begin();
    const response = await fetch(attempt.callback, { headers: { cookie: attempt.cookie }, redirect: 'manual' });
    assert.equal(response.headers.get('location'), origin + '/');
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('lasso_todo_session='));
    assert.match(setCookie, /HttpOnly; SameSite=Lax/);
    const sessionCookie = setCookie.split(';')[0];
    const session = await (await fetch(origin + '/auth/session', { headers: { cookie: sessionCookie } })).json();
    assert.equal(session.authenticated, true); assert.equal(session.name, '<b>Literal user</b>');
    assert.equal(JSON.stringify(session).includes('fixture-access-token'), false);
    assert.deepEqual(await (await fetch(origin + '/todos', { headers: { cookie: sessionCookie } })).json(), [original]);
    const post = headers => fetch(origin + '/todos', { method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title: 'authenticated write' }) });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ origin: 'https://evil.example', 'x-todo-csrf': session.csrf })).status, 403);
    assert.equal((await post({ origin, 'x-todo-csrf': session.csrf })).status, 201);
    assert.equal((await fetch(origin + '/auth/logout', { method: 'POST', headers: { cookie: sessionCookie } })).status, 403);
    const logout = await fetch(origin + '/auth/logout', { method: 'POST', headers: { cookie: sessionCookie, origin, 'x-todo-csrf': session.csrf } });
    assert.equal(logout.status, 200); assert.equal(new URL((await logout.json()).redirect).origin, issuer);
    assert.equal((await fetch(origin + '/todos', { headers: { cookie: sessionCookie } })).status, 401);
    const fresh = await begin(); const signed = await fetch(fresh.callback, { headers: { cookie: fresh.cookie }, redirect: 'manual' });
    const stale = signed.headers.getSetCookie().find(value => value.startsWith('lasso_todo_session=')).split(';')[0];
    await stop(); await start();
    assert.equal((await fetch(origin + '/todos', { headers: { cookie: stale } })).status, 401);
    const spoofedHost = await new Promise((resolve, reject) => { const request = httpRequest(origin + '/auth/session', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
    assert.equal(spoofedHost, 403);
    for (let i = 0; i < 256; i++) assert.equal((await fetch(origin + '/auth/login', { redirect: 'manual' })).status, 303);
    assert.equal((await fetch(origin + '/auth/login', { redirect: 'manual' })).status, 503, 'Bounded pending login capacity');
    const saved = JSON.parse(await readFile(file)); assert.equal(saved.length, 2); assert.equal(saved[0].id, original.id);
  } finally {
    if (child) await stop();
    await new Promise(resolve => provider.close(resolve));
  }
});

test('packaged configure helper preserves storage and rejects insecure issuer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lasso-todo-sso-config-'));
  const todo = path.join(root, 'todo'); await mkdir(todo); await mkdir(path.join(root, 'zitadel'));
  await writeFile(path.join(root, 'zitadel', 'service.json'), '{}');
  const file = path.join(todo, 'service.json');
  const original = { id: 'todo', artifact: { source: { repo: 'service-lasso/lasso-todo' } }, depend_on: ['@node', 'todo-api'], env: { TODO_DATA_FILE: 'retained.json', TODO_API_STATE: 'retained.state' } };
  await writeFile(file, JSON.stringify(original));
  const helper = process.env.SSO_RUNTIME_ROOT ? path.join(process.env.SSO_RUNTIME_ROOT, 'configure-sso.mjs') : fileURLToPath(new URL('../scripts/configure-sso.mjs', import.meta.url));
  assert.notEqual(spawnSync(process.execPath, [helper, todo, 'enable', 'http://localhost:18084', 'client']).status, 0);
  assert.deepEqual(JSON.parse(await readFile(file)), original);
  assert.equal(spawnSync(process.execPath, [helper, todo, 'enable', 'https://localhost:18084', 'client']).status, 0);
  const configured = JSON.parse(await readFile(file)); assert.equal(configured.env.TODO_API_STATE, 'retained.state'); assert.ok(configured.depend_on.includes('todo-api')); assert.ok(configured.depend_on.includes('zitadel'));
  assert.equal(spawnSync(process.execPath, [helper, todo, 'disable']).status, 0);
  assert.deepEqual(JSON.parse(await readFile(file)), original);
});

test('partial or insecure sign-in configuration cannot silently enable anonymous mode', async () => {
  const { createAuth } = await import('../runtime/auth.mjs');
  assert.equal(await createAuth({}, 18552), undefined);
  await assert.rejects(createAuth({ TODO_OIDC_CLIENT_ID: 'client' }, 18552), /all Todo OIDC/);
  await assert.rejects(createAuth({ TODO_OIDC_CLIENT_ID: 'client', TODO_ORIGIN: 'http://127.0.0.1:18552', TODO_OIDC_ISSUER: 'http://localhost:18084' }, 18552), /trusted HTTPS/);
});
