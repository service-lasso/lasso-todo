import * as oidc from 'openid-client';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'lasso_todo_session';
const pendingName = 'lasso_todo_login';
const opaque = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (request, name) => {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 && /^[a-zA-Z0-9_-]{43}$/.test(values[0].slice(name.length + 1)) ? values[0].slice(name.length + 1) : undefined;
};

export async function createAuth(env, port) {
  const fields = ['TODO_OIDC_ISSUER', 'TODO_OIDC_CLIENT_ID', 'TODO_ORIGIN'];
  if (![...fields, 'TODO_OIDC_AUDIENCE'].some(field => env[field])) return undefined;
  if (!fields.every(field => env[field])) throw Error('Configure all Todo OIDC fields; no anonymous fallback.');
  const issuer = new URL(env.TODO_OIDC_ISSUER);
  const origin = new URL(env.TODO_ORIGIN);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/') throw Error('Use a trusted HTTPS issuer origin.');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || Number(origin.port) !== port || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('Use the allocated loopback Todo origin.');
  const clientId = env.TODO_OIDC_CLIENT_ID;
  if (clientId.length > 256 || /\s/.test(clientId)) throw Error('Invalid OIDC client ID.');
  const apiMode = Boolean(env.TODO_API_STATE);
  const audience = env.TODO_OIDC_AUDIENCE;
  if (apiMode && (!audience || audience.length > 256 || /[\s${}]/.test(audience))) throw Error('Configure the secured API project audience; no fallback.');
  const config = await oidc.discovery(issuer, clientId, { token_endpoint_auth_method: 'none' }, oidc.None(), { timeout: 5 });
  oidc.enableNonRepudiationChecks(config);
  const metadata = config.serverMetadata();
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint']) {
    if (!metadata[field] && field === 'end_session_endpoint') continue;
    const endpoint = new URL(metadata[field]);
    if (endpoint.protocol !== 'https:' || endpoint.origin !== issuer.origin || endpoint.username || endpoint.password || endpoint.hash) throw Error('Unexpected identity endpoint origin.');
  }
  const sessions = new Map(), pending = new Map();
  const maxEntries = 256;
  const trim = map => { const now = Date.now(); for (const [key, entry] of map) if (entry.expires <= now) map.delete(key); };
  const setCookie = (response, name, value, seconds, cookiePath = '/') => {
    const entry = `${name}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
    const previous = response.getHeader('set-cookie') ?? [];
    response.setHeader('set-cookie', [...(Array.isArray(previous) ? previous : [previous]), entry]);
  };
  const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  const redirect = (response, location) => { response.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); };
  const current = request => { trim(sessions); return sessions.get(cookie(request, cookieName)); };
  const csrf = (request, session) => request.headers.origin === origin.origin && equal(request.headers['x-todo-csrf'], session?.csrf);
  const callback = new URL('/auth/callback', origin).href;
  return {
    origin: origin.origin,
    async handle(request, response) {
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith('/auth/')) return false;
      if (request.headers.host !== origin.host) { json(response, 403, { error: 'Use the configured Todo origin' }); return true; }
      if (request.method === 'GET' && url.pathname === '/auth/session') {
        const session = current(request);
        json(response, 200, session ? { enabled: true, authenticated: true, name: session.name, csrf: session.csrf } : { enabled: true, authenticated: false });
      } else if (request.method === 'GET' && url.pathname === '/auth/login') {
        trim(pending);
        if (pending.size >= maxEntries) { json(response, 503, { error: 'Sign-in busy; try again later' }); return true; }
        const previous = cookie(request, pendingName); if (previous) pending.delete(previous);
        const id = opaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce(), state = oidc.randomState();
        pending.set(id, { verifier, nonce, state, expires: Date.now() + 300000 });
        setCookie(response, pendingName, id, 300, '/auth');
        redirect(response, oidc.buildAuthorizationUrl(config, { redirect_uri: callback, scope: 'openid profile email' + (apiMode ? ` urn:zitadel:iam:org:project:id:${audience}:aud` : ''), code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce }).href);
      } else if (request.method === 'GET' && url.pathname === '/auth/callback') {
        trim(pending);
        const id = cookie(request, pendingName), transaction = pending.get(id);
        pending.delete(id);
        setCookie(response, pendingName, '', 0, '/auth');
        try {
          if (!transaction) throw Error('Missing login transaction');
          const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true });
          const claims = tokens.claims();
          if (apiMode && (typeof tokens.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(tokens.access_token) || tokens.access_token.length > 8185 || typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.token_type?.toLowerCase() !== 'bearer')) throw Error('Valid access token required');
          const seconds = Math.min(3600, Math.floor(claims.exp - Date.now() / 1000), apiMode ? Math.floor(tokens.expires_in) : 3600);
          if (!claims.sub || seconds <= 0) throw Error('Invalid session lifetime');
          trim(sessions);
          if (sessions.size >= maxEntries) throw Error('Session capacity reached');
          sessions.delete(cookie(request, cookieName));
          const sessionId = opaque();
          sessions.set(sessionId, { csrf: opaque(), expires: Date.now() + seconds * 1000, accessToken: apiMode ? tokens.access_token : undefined, name: String(claims.name ?? claims.preferred_username ?? 'Signed-in user').slice(0, 160) });
          setCookie(response, cookieName, sessionId, seconds);
          redirect(response, origin.href);
        } catch {
          // Codes, token claims and provider errors must never reach logs/browser.
          redirect(response, new URL('/?signin=failed', origin).href);
        }
      } else if (request.method === 'POST' && url.pathname === '/auth/logout') {
        const session = current(request);
        if (!session || !csrf(request, session)) { json(response, 403, { error: 'Invalid session request' }); return true; }
        sessions.delete(cookie(request, cookieName));
        setCookie(response, cookieName, '', 0);
        const logout = metadata.end_session_endpoint ? oidc.buildEndSessionUrl(config, { client_id: clientId, post_logout_redirect_uri: origin.href }).href : origin.href;
        json(response, 200, { redirect: logout });
      } else json(response, 404, { error: 'Not found' });
      return true;
    },
    apiHeaders(request) {
      const session = current(request);
      if (!apiMode || !session?.accessToken) throw Error('Authorized access token unavailable');
      return { authorization: `Bearer ${session.accessToken}` };
    },
    authorize(request, response) {
      if (request.headers.host !== origin.host) { json(response, 403, { error: 'Use the configured Todo origin' }); return false; }
      const session = current(request);
      if (!session) { json(response, 401, { error: 'Sign in to use Todo' }); return false; }
      if (request.method !== 'GET' && !csrf(request, session)) { json(response, 403, { error: 'Invalid session request' }); return false; }
      return true;
    }
  };
}
