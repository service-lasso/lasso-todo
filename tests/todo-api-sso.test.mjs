import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync,sign,createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

test('signed login forwards only the session access token to the API and never falls back',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'todo-secured-proxy-'));
 const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem'),config=path.join(root,'openssl.cnf');
 await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
 const openssl=process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl';
 assert.equal(spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-config',config],{windowsHide:true}).status,0);
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'};
 const codes=new Map();let issuer,tokenMode='valid';
 const identity=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))};
  if(req.url==='/.well-known/openid-configuration')return json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
  if(req.url==='/keys')return json({keys:[jwk]});
  if(req.url==='/token'){
   let body='';for await(const chunk of req)body+=chunk;const form=new URLSearchParams(body),entry=codes.get(form.get('code'));codes.delete(form.get('code'));
   if(!entry||createHash('sha256').update(form.get('code_verifier')??'').digest('base64url')!==entry.challenge){res.writeHead(400);return res.end()}
   const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'web-client',sub:'user',nonce:entry.nonce,iat:now,exp:now+600};
   const payload=[Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
   return json({access_token:tokenMode==='missing'?undefined:'session-access',expires_in:tokenMode==='expired'?0:600,token_type:'Bearer',id_token:payload+'.'+sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')});
  }
  res.writeHead(404);res.end();
 });identity.listen(0,'127.0.0.1');await once(identity,'listening');issuer=`https://127.0.0.1:${identity.address().port}`;
 let denied=false;const captured=[];const rows=[{id:'retained',title:'original'}];
 // This proxy fixture checks forwarded bytes. Real Go enforcement is independently tested in the API repository.
 const api=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');if(req.url==='/healthz'){res.end('{}');return}
  captured.push(req.headers.authorization);
  if(denied||req.headers.authorization!=='Bearer session-access'){res.writeHead(401);res.end('{}');return}
  if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const row={id:randomUUID(),title:input.title};rows.push(row);res.writeHead(201);res.end(JSON.stringify(row));return}
  res.end(JSON.stringify(rows));
 });api.listen(0,'127.0.0.1');await once(api,'listening');
 const apiDir=path.join(root,'todo-api');await mkdir(path.join(apiDir,'.state'),{recursive:true});
 const state=path.join(apiDir,'.state','runtime.json');await writeFile(state,JSON.stringify({ports:{web:api.address().port}}));
 await writeFile(path.join(apiDir,'service.json'),JSON.stringify({id:'todo-api',meta:{apiAuthContract:'zitadel-introspection-v1'},env:{TODO_API_AUTH_MODE:'zitadel',TODO_OIDC_ISSUER:issuer,TODO_OIDC_AUDIENCE:'project',TODO_OIDC_CLIENT_ID:'web-client'}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const origin=`http://127.0.0.1:${port}`;let child,closed;
 const start=async()=>{
  child=spawn(process.execPath,[process.env.SSO_RUNTIME_ROOT ? path.join(process.env.SSO_RUNTIME_ROOT,'runtime/server.mjs') : fileURLToPath(new URL('../runtime/server.mjs',import.meta.url))],{env:{...process.env,TODO_PORT:String(port),TODO_DATA_FILE:path.join(root,'todos.json'),TODO_DATABASE_STATE:'',TODO_API_STATE:state,TODO_ORIGIN:origin,TODO_OIDC_ISSUER:issuer,TODO_OIDC_CLIENT_ID:'web-client',TODO_OIDC_AUDIENCE:'project',NODE_EXTRA_CA_CERTS:cert},stdio:'pipe',windowsHide:true});closed=once(child,'close');
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok)return}catch{}if(child.exitCode!==null)throw Error('Secured proxy startup failed');await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Readiness timeout');
 };
 const stop=async()=>{child.kill();await closed;child=undefined};
 const login=async()=>{
  const pending=await fetch(origin+'/auth/login',{redirect:'manual'});const authorize=new URL(pending.headers.get('location'));assert.ok(authorize.searchParams.get('scope').includes('urn:zitadel:iam:org:project:id:project:aud'));
  const code=randomUUID();codes.set(code,{nonce:authorize.searchParams.get('nonce'),challenge:authorize.searchParams.get('code_challenge')});
  return fetch(origin+'/auth/callback?code='+code+'&state='+authorize.searchParams.get('state'),{headers:{cookie:pending.headers.get('set-cookie').split(';')[0]},redirect:'manual'});
 };
 try{
  await start();assert.equal((await fetch(origin+'/todos',{headers:{authorization:'Bearer session-access'}})).status,401);assert.equal(captured.length,0);
  const response=await login();assert.equal(response.headers.get('location'),origin+'/');const cookie=response.headers.getSetCookie().find(value=>value.startsWith('lasso_todo_session=')).split(';')[0];
  const session=await(await fetch(origin+'/auth/session',{headers:{cookie}})).json();assert.ok(!JSON.stringify(session).includes('session-access'));
  const list=await fetch(origin+'/todos',{headers:{cookie,authorization:'Bearer browser-supplied'}});assert.equal(list.status,200);assert.deepEqual(await list.json(),rows);assert.equal(captured.at(-1),'Bearer session-access');
  const create=()=>fetch(origin+'/todos',{method:'POST',headers:{cookie,origin,'x-todo-csrf':session.csrf,'content-type':'application/json',authorization:'Bearer browser-supplied'},body:JSON.stringify({title:'signed-in create'})});
  assert.equal((await create()).status,201);assert.equal(captured.at(-1),'Bearer session-access');assert.equal(rows.length,2);
  denied=true;assert.equal((await fetch(origin+'/todos',{headers:{cookie}})).status,401);assert.equal((await create()).status,401);assert.equal(rows.length,2,'rejected write cannot change data');denied=false;
  for(const mode of ['missing','expired']){tokenMode=mode;assert.equal((await login()).headers.get('location'),origin+'/?signin=failed')}
  await stop();await start();assert.equal((await fetch(origin+'/todos',{headers:{cookie}})).status,401);
 }finally{if(child)await stop();await new Promise(resolve=>api.close(resolve));await new Promise(resolve=>identity.close(resolve))}
});
