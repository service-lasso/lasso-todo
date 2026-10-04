import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

test('audience-only partial identity cannot enable anonymous mode', async () => {
 const {createAuth}=await import(process.env.SSO_RUNTIME_ROOT ? pathToFileURL(path.join(process.env.SSO_RUNTIME_ROOT,'runtime/auth.mjs')).href : '../runtime/auth.mjs');
 await assert.rejects(createAuth({TODO_OIDC_AUDIENCE:'project'},18552),/all Todo OIDC/);
});

test('paired helper requires secured API and private-file paths, preserves storage and supports explicit disable',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'todo-api-auth-config-'));
 for(const name of ['todo','todo-api','zitadel'])await mkdir(path.join(root,name));
 await writeFile(path.join(root,'zitadel','service.json'),'{}');
 const todoFile=path.join(root,'todo','service.json'),apiFile=path.join(root,'todo-api','service.json');
 const todo={id:'todo',artifact:{source:{repo:'service-lasso/lasso-todo'}},depend_on:['@node','todo-api'],env:{TODO_DATA_FILE:'retained',TODO_API_STATE:'retained.state'}};
 const api={id:'todo-api',meta:{apiAuthContract:'zitadel-introspection-v1'},depend_on:['postgres'],env:{TODO_API_AUTH_MODE:'anonymous',TODO_DATABASE_STATE:'retained.database'}};
 await writeFile(todoFile,JSON.stringify(todo));await writeFile(apiFile,JSON.stringify(api));
 const secret=path.join(root,'private-secret');await writeFile(secret,'fixture-api-secret',{mode:0o600});
 const helper=process.env.SSO_RUNTIME_ROOT ? path.join(process.env.SSO_RUNTIME_ROOT,'configure-sso.mjs') : fileURLToPath(new URL('../scripts/configure-sso.mjs',import.meta.url));
 const run=(...args)=>spawnSync(process.execPath,[helper,path.join(root,'todo'),...args],{windowsHide:true});
 assert.notEqual(run('enable','https://identity.invalid','web-client').status,0);
 assert.deepEqual(JSON.parse(await readFile(todoFile)),todo);assert.deepEqual(JSON.parse(await readFile(apiFile)),api);
 assert.equal(run('enable','https://identity.invalid','web-client','project','api-client',secret).status,0);
 let paired=JSON.parse(await readFile(apiFile));assert.equal(paired.env.TODO_API_AUTH_MODE,'zitadel');assert.equal(paired.env.TODO_OIDC_CLIENT_ID,'web-client');assert.equal(paired.env.TODO_OIDC_AUDIENCE,'project');assert.equal(paired.env.TODO_API_CLIENT_SECRET_FILE,secret);
 assert.equal(JSON.parse(await readFile(todoFile)).env.TODO_OIDC_AUDIENCE,'project');
 assert.ok(!(await readFile(apiFile,'utf8')).includes('fixture-api-secret'),'credential bytes never enter manifest');
 assert.equal(run('disable').status,0);assert.deepEqual(JSON.parse(await readFile(todoFile)),todo);assert.deepEqual(JSON.parse(await readFile(apiFile)),api);
 delete api.meta.apiAuthContract;await writeFile(apiFile,JSON.stringify(api));assert.notEqual(run('enable','https://identity.invalid','web-client','project','api-client',secret).status,0);assert.deepEqual(JSON.parse(await readFile(todoFile)),todo);
});
