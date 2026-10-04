import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { assetNames, createPublisher, inspectCandidateDirectory, downloadAsset, limits, parseBoundedJson } from "../scripts/publish-development-candidate.mjs";
import { validateWorkflow } from "../scripts/validate-development-candidate-workflow.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const repository = "service-lasso/service-template";
const sha = "a".repeat(40);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const code = (expected) => (error) => error.code === expected;
function tarMember(name, bytes, type = "0", mode = 0o664) {
  const header = Buffer.alloc(512); header.write(name, 0, 100, "ascii");
  for (const [start, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) header.write(value.toString(8).padStart(width - 1, "0") + "\0", start, width, "ascii");
  header.fill(32, 148, 156); header[156] = type.charCodeAt(0); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function archiveFor(contract, payload = Buffer.from("accepted archive")) {
  return gzipSync(Buffer.concat([tarMember("pax_global_header", Buffer.from(`52 comment=${sha}\n`), "g", 0o666), tarMember("README.md", payload), tarMember("template-contract.json", contract), Buffer.alloc(1024)]));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "template-held-publisher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = JSON.parse(await readFile(join(root, "template-contract.json"), "utf8"));
  const payload = Buffer.from("accepted archive");
  policy.inventory = [{ path: "README.md", sha256: hash(payload), bytes: payload.length, mode: "0644" }];
  for (;;) {
    const unsigned = { ...policy }; delete unsigned.contractDigest;
    policy.contractDigest = hash(JSON.stringify(canonical(unsigned)));
    const next = payload.length + json(policy).length + policy.quotas.maximumManifestBytes + policy.quotas.maximumProvenanceBytes + policy.quotas.maximumConfigBytes;
    if (next === policy.quotas.maximumTotalBytes) break; policy.quotas.maximumTotalBytes = next;
  }
  const contract = json(policy);
  const archive = archiveFor(contract, payload);
  const candidate = { schemaVersion: 1, kind: "development-template-candidate", templateCommit: sha, templateVersion: "1.0.0-dev", contractDigest: policy.contractDigest, archiveSha256: hash(archive), contractSha256: hash(contract), releaseTag: `template-v1.0.0-dev-${sha}` };
  const bytes = { "service-template.tar.gz": archive, "template-candidate.json": json(candidate), "template-contract.json": contract };
  bytes.SHA256SUMS = Buffer.from(assetNames.slice(0, 3).map((name) => `${hash(bytes[name])}  ${name}`).join("\n") + "\n");
  for (const name of assetNames) await writeFile(join(directory, name), bytes[name]);
  return { directory, candidate, bytes, local: await inspectCandidateDirectory(directory) };
}
const response = (value, status = 200, headers = {}) => new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value), { status, headers });

// Real adapter injection: every HTTP request, mutation body, private ID read,
// public download and before-write policy round passes through production code.
function provider(value, options = {}) {
  const state = { release: null, tag: null, writes: [], calls: [], bodies: {}, policyRounds: 0, published: false };
  const asset = (name, index) => ({ id: index + 101, name, size: value.bytes[name].length, digest: `sha256:${hash(value.bytes[name])}`, url: `https://api.github.com/repos/${repository}/releases/assets/${index + 101}`, browser_download_url: `https://github.com/${repository}/releases/download/${value.candidate.releaseTag}/${name}` });
  const complete = () => ({ id: 42, tag_name: value.candidate.releaseTag, target_commitish: sha, draft: false, prerelease: true, immutable: true, assets: assetNames.map(asset) });
  if (options.existing) { state.release = { ...complete(), ...options.existing }; state.tag = { type: "commit", sha }; for (const name of assetNames) state.bodies[name] = value.bytes[name]; }
  if (options.orphan) state.tag = { type: "commit", sha: options.orphan };
  const request = async (url, init) => {
    state.calls.push({ url, init });
    await options.before?.(url, init, state);
    const parsed = new URL(url); const path = parsed.pathname.replace(`/repos/${repository}`, "");
    if (parsed.hostname === "github.com" || parsed.hostname === "release-assets.githubusercontent.com") {
      assert.equal(init.headers, undefined); assert.equal(init.redirect, "manual");
      const name = decodeURIComponent(parsed.pathname.split("/").at(-1));
      assert.equal(state.published || !!options.existing || parsed.hostname === "release-assets.githubusercontent.com", true);
      return response(options.publicMismatch ? Buffer.from("bad") : state.bodies[name]);
    }
    assert.equal(init.headers.authorization, "Bearer private-test-token");
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    if (init.method === "POST" || init.method === "PATCH") {
      assert.equal(state.calls.at(-2).url, `https://api.github.com/repos/${repository}/branches/develop/protection`);
      state.writes.push({ path, method: init.method });
      if (options.failWrite === state.writes.length) throw new Error("Unknown write outcome");
      if (path === "/git/refs") { assert.equal(state.tag, null); const body = JSON.parse(init.body); assert.equal(body.ref, `refs/tags/${value.candidate.releaseTag}`); assert.equal(body.sha, sha); state.tag = { type: "commit", sha }; return response({ ref: body.ref, object: state.tag }, 201); }
      if (path === "/releases") { assert.equal(state.release, null); const body = JSON.parse(init.body); assert.equal(body.draft, true); state.release = { ...body, id: 42, immutable: false, assets: [] }; return response(state.release, 201); }
      if (parsed.hostname === "uploads.github.com") { assert.equal(state.release.draft, true); const name = parsed.searchParams.get("name"); assert.ok(assetNames.includes(name)); assert.deepEqual(init.body, value.bytes[name]); state.bodies[name] = Buffer.from(init.body); const next = asset(name, assetNames.indexOf(name)); state.release.assets.push(next); return response(next, 201); }
      if (path === "/releases/42" && init.method === "PATCH") { assert.deepEqual(JSON.parse(init.body), { draft: false }); assert.equal(state.release.assets.length, 4); state.release.draft = false; state.release.immutable = !options.mutableFinal; state.published = true; return response(state.release); }
      throw new Error(`Unexpected mutation ${url}`);
    }
    if (path === "/immutable-releases") { state.policyRounds += 1; return response({ enabled: options.policyLoss !== state.writes.length }); }
    if (path === "/environments/development-candidate") return response({ protection_rules: options.unprotectedEnvironment ? [] : [{ type: "wait_timer" }], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } });
    if (path === "/branches/develop") return response({ protected: !options.unprotectedBranch, commit: { sha: options.sourceMoved ? "b".repeat(40) : sha } });
    if (path === "/branches/develop/protection") return options.deniedProtection ? response({}, 404) : response({ required_pull_request_reviews: { required_approving_review_count: 0 } });
    if (path === `/git/ref/tags/${value.candidate.releaseTag}`) return state.tag ? response({ ref: options.wrongRef ? "refs/tags/other" : `refs/tags/${value.candidate.releaseTag}`, object: options.annotated ? { type: "tag", sha: "b".repeat(40) } : state.tag }) : response({}, 404);
    if (path.startsWith("/git/tags/")) return response({ sha: "b".repeat(40), object: options.tagCycle ? { type: "tag", sha: "b".repeat(40) } : { type: "commit", sha: options.tagMismatch ? "d".repeat(40) : sha } });
    if (path === `/releases/tags/${value.candidate.releaseTag}` || path === "/releases/42") return state.release ? response(state.release) : response({}, 404);
    if (path.startsWith("/releases/assets/")) {
      assert.equal(state.release.draft, true); const id = Number(path.split("/").at(-1)); const name = state.release.assets.find((entry) => entry.id === id)?.name; assert.ok(name);
      if (options.privateRedirect) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/private/${name}` } });
      return response(options.privateMismatch ? Buffer.from("wrong") : state.bodies[name]);
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { state, request, complete };
}
function publish(value, server, overrides = {}) { return createPublisher({ request: server.request, token: "private-test-token", repository, ref: "refs/heads/develop", sha, ownerContractBytes: value.bytes["template-contract.json"], ...overrides }).publish(value.local); }

test("workflow binds once and invokes one held-byte draft publisher", async () => {
  const workflow = await readFile(join(root, ".github/workflows/development-candidate.yml"), "utf8");
  assert.deepEqual(validateWorkflow(workflow).jobs.map((job) => [job.name, job.permissions]), [["bind-candidate", "read"], ["publish-candidate", "write"]]);
  assert.throws(() => validateWorkflow(workflow.replace("      contents: write", "        contents: write")), /indented contents scope/);
  assert.throws(() => validateWorkflow(workflow + "\ngh release create\n"), /held-byte/);
});
for (const privateRedirect of [false, true]) test(`actual adapter publishes once only after all private ID bytes; redirect=${privateRedirect}`, async (t) => {
  const value = await fixture(t); const server = provider(value, { privateRedirect, annotated: true });
  const result = await publish(value, server); assert.equal(result.mode, "verified");
  assert.deepEqual(result.publication.assets.map(asset => asset.name), [...assetNames].sort());
  assert.equal(result.publication.targetCommit, sha); assert.equal(result.publication.immutable, true);
  for (const asset of result.publication.assets) {
    assert.equal(asset.sha256, hash(value.bytes[asset.name]));
    assert.equal(asset.size, value.bytes[asset.name].length);
    assert.equal(asset.url, `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`);
  }
  assert.deepEqual(server.state.writes.map((write) => write.method), ["POST", "POST", "POST", "POST", "POST", "POST", "PATCH"]);
  assert.equal(server.state.writes.filter((write) => write.method === "PATCH").length, 1);
  assert.ok(server.state.policyRounds >= server.state.writes.length);
  const firstPublic = server.state.calls.findIndex((call) => call.url.startsWith("https://github.com/"));
  const transition = server.state.calls.findIndex((call) => call.init.method === "PATCH"); assert.ok(firstPublic > transition);
});
test("completed exact tuple recovery is strictly read-only with actual tag proof and public bytes", async (t) => {
  const value = await fixture(t); const server = provider(value, { existing: {}, annotated: true });
  const result = await publish(value, server);
  assert.equal(result.mode, "recovered"); assert.equal(server.state.writes.length, 0);
  assert.equal(result.publication.releaseId, 42);
  assert.deepEqual(result.publication.assets.map(asset => asset.name), [...assetNames].sort());
});
for (const orphan of [sha, "b".repeat(40)]) test(`orphan preexisting tag fails with zero writes (${orphan.slice(0, 1)})`, async (t) => {
  const value = await fixture(t); const server = provider(value, { orphan }); await assert.rejects(() => publish(value, server), code("collision")); assert.equal(server.state.writes.length, 0);
});
for (const existing of [{ draft: true }, { immutable: false }, { assets: [] }, { target_commitish: "b".repeat(40) }]) test(`preexisting incomplete tuple fails zero-write ${JSON.stringify(existing)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, { existing }); await assert.rejects(() => publish(value, server), code("release_tuple")); assert.equal(server.state.writes.length, 0);
});
for (const options of [{ tagCycle: true, annotated: true }, { tagMismatch: true, annotated: true }, { wrongRef: true }]) test(`recovery proves recursive fixed tag identities ${JSON.stringify(options)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, { existing: {}, ...options }); await assert.rejects(() => publish(value, server), code("tag")); assert.equal(server.state.writes.length, 0);
});
for (let policyLoss = 0; policyLoss < 7; policyLoss += 1) test(`policy loss immediately before mutation ${policyLoss + 1} stops further writes`, async (t) => {
  const value = await fixture(t); const server = provider(value, { policyLoss }); await assert.rejects(() => publish(value, server), code("immutable_releases")); assert.equal(server.state.writes.length, policyLoss); assert.equal(server.state.published, false);
});
for (const options of [{ unprotectedEnvironment: true }, { unprotectedBranch: true }, { sourceMoved: true }, { deniedProtection: true }]) test(`actual adapter requires protected exact develop/environment ${JSON.stringify(options)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, options); await assert.rejects(() => publish(value, server)); assert.equal(server.state.writes.length, 0);
});
test("private byte mismatch retains draft and never publishes/deletes/retries", async (t) => {
  const value = await fixture(t); const server = provider(value, { privateMismatch: true }); await assert.rejects(() => publish(value, server)); assert.equal(server.state.release.draft, true); assert.equal(server.state.writes.length, 6); assert.equal(server.state.published, false);
});
for (let failWrite = 1; failWrite <= 7; failWrite += 1) test(`unknown write outcome ${failWrite} causes no retry or compensating mutation`, async (t) => {
  const value = await fixture(t); const server = provider(value, { failWrite }); await assert.rejects(() => publish(value, server), /Unknown write outcome/); assert.equal(server.state.writes.length, failWrite);
});
for (const options of [{ publicMismatch: true }, { mutableFinal: true }]) test(`final acceptance fails closed ${JSON.stringify(options)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, options); await assert.rejects(() => publish(value, server)); assert.equal(server.state.writes.length, 7);
});
test("paths and caller-owned buffers can change after acceptance without changing uploaded bytes", async (t) => {
  const value = await fixture(t); const original = Buffer.from(value.bytes["service-template.tar.gz"]); let changed = false;
  const server = provider(value, { before: async () => { if (!changed) { changed = true; await writeFile(join(value.directory, "service-template.tar.gz"), "replacement"); value.local.bytes["service-template.tar.gz"].fill(0); } } });
  await publish(value, server); assert.deepEqual(server.state.bodies["service-template.tar.gz"], original);
});
for (const alter of ["duplicateId", "extra", "wrongSize", "wrongDigest", "wrongUrl", "renamed", "changedId"]) test(`actual private asset tuple rejects ${alter} before publish`, async (t) => {
  const value = await fixture(t); let changed = false;
  const server = provider(value, { before: async (url, init, state) => { if (!changed && init.method === "GET" && url.endsWith("/releases/42") && state.release?.assets.length === 4) { changed = true; const assets = state.release.assets; if (alter === "duplicateId") assets[1].id = assets[0].id; if (alter === "extra") assets.push({ ...assets[0], id: 999, name: "extra" }); if (alter === "wrongSize") assets[0].size += 1; if (alter === "wrongDigest") assets[0].digest = "sha256:" + "0".repeat(64); if (alter === "wrongUrl") assets[0].url = "https://api.github.com/other"; if (alter === "renamed") assets[0].name = "renamed"; if (alter === "changedId") assets[0].id = 999; } } });
  await assert.rejects(() => publish(value, server), code("release_tuple")); assert.equal(server.state.published, false);
});

test("raw JSON rejects duplicate keys including escaped duplicates and nested duplicates", () => {
  for (const text of ['{"enabled":true,"enabled":false}', '{"enabled":true,"\\u0065nabled":true}', '{"a":{"x":1,"x":2}}']) assert.throws(() => parseBoundedJson(Buffer.from(text)), code("duplicate_json"));
  assert.throws(() => parseBoundedJson(Buffer.alloc(limits.metadata + 1)), code("bounds"));
  assert.throws(() => parseBoundedJson(Buffer.from([0xff])), code("json"));
  assert.throws(() => parseBoundedJson(Buffer.from("[".repeat(34) + "0" + "]".repeat(34))), code("bounds"));
});
for (const mode of ["duplicate", "length", "stream", "stalledFetch", "stalledBody", "redirect"]) test(`actual authenticated metadata adapter fails bounded ${mode} with no writes`, async (t) => {
  const value = await fixture(t); const server = provider(value);
  const ordinary = server.request;
  server.request = async (url, init) => {
    if (!url.endsWith("/immutable-releases")) return ordinary(url, init);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    if (mode === "duplicate") return response(Buffer.from('{"enabled":true,"enabled":true}'));
    if (mode === "length") return response(Buffer.from("{}"), 200, { "content-length": String(limits.metadata + 1) });
    if (mode === "stream") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limits.metadata)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
    if (mode === "stalledFetch") return new Promise(() => {});
    if (mode === "stalledBody") return new Response(new ReadableStream({ start() {} }));
    return new Response(null, { status: 302, headers: { location: "https://example.invalid" } });
  };
  await assert.rejects(() => publish(value, server, { deadlineMs: 20 })); assert.equal(server.state.writes.length, 0);
});
for (const url of ["https://user@github.com/a", "https://github.com:443/a", "https://github.com:444/a", "https://github.com/a#", "http://github.com/a", "https://evil.invalid/a"]) test(`download URL grammar rejects before network ${url}`, async () => {
  let calls = 0; await assert.rejects(() => downloadAsset(url, async () => { calls += 1; }), code("asset_url")); assert.equal(calls, 0);
});
test("public redirects never forward credentials; bad redirect never receives a request", async () => {
  const calls = [];
  const request = async (url, init) => { calls.push({ url, init }); assert.equal(init.headers, undefined); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset" } }) : response(Buffer.from("accepted")); };
  assert.deepEqual(await downloadAsset("https://github.com/a", request, 8), Buffer.from("accepted"));
  assert.equal(calls.length, 2);
  for (const location of ["https://example.invalid/a", "https://user@github.com/a", "https://github.com:443/a", "https://github.com/a#frag"]) { let count = 0; await assert.rejects(() => downloadAsset("https://github.com/a", async () => { count += 1; return new Response(null, { status: 302, headers: { location } }); }), code("asset_url")); assert.equal(count, 1); }
});
for (const mode of ["length", "stream", "stall", "redirectBudget"]) test(`actual public download bounds/deadline ${mode}`, async () => {
  const request = async () => mode === "length" ? response(Buffer.from("a"), 200, { "content-length": "9" }) : mode === "stream" ? response(Buffer.alloc(9)) : mode === "stall" ? new Response(new ReadableStream({ start() {} })) : new Response(null, { status: 302, headers: { location: "https://github.com/next" } });
  await assert.rejects(() => downloadAsset("https://github.com/a", request, 8, 20));
});
test("local candidate files enforce per-file quota before read, canonical descriptor and exact checksums", async (t) => {
  const value = await fixture(t); await writeFile(join(value.directory, "template-candidate.json"), Buffer.alloc(limits.descriptor + 1)); await assert.rejects(() => inspectCandidateDirectory(value.directory), code("candidate_asset"));
  await writeFile(join(value.directory, "template-candidate.json"), Buffer.from(JSON.stringify(value.candidate))); await assert.rejects(() => inspectCandidateDirectory(value.directory), code("candidate"));
  await writeFile(join(value.directory, "template-candidate.json"), value.bytes["template-candidate.json"]); await writeFile(join(value.directory, "SHA256SUMS"), "changed\n"); await assert.rejects(() => inspectCandidateDirectory(value.directory), code("sums"));
});

test("source SHA and exact checked-out owner policy substitutions fail before all network writes", async (t) => {
  const value = await fixture(t);
  for (const overrides of [{ sha: "b".repeat(40) }, { ownerContractBytes: Buffer.from("{}\n") }]) { const server = provider(value); await assert.rejects(() => publish(value, server, overrides)); assert.equal(server.state.calls.length, 0); }
});
test("tag absent at recovery and tag mismatch after creation never gain acceptance", async (t) => {
  const value = await fixture(t); const recovered = provider(value, { existing: {} }); recovered.state.tag = null;
  await assert.rejects(() => publish(value, recovered)); assert.equal(recovered.state.writes.length, 0);
  const created = provider(value, { annotated: true, tagMismatch: true }); await assert.rejects(() => publish(value, created), code("tag")); assert.equal(created.state.writes.length, 1);
});
test("provider collision appearing during repeated absence check prevents tag write", async (t) => {
  const value = await fixture(t); let refs = 0;
  const server = provider(value, { before: async (url, init, state) => { if (url.includes("/git/ref/tags/") && ++refs === 2) state.tag = { type: "commit", sha }; } });
  await assert.rejects(() => publish(value, server), code("collision")); assert.equal(server.state.writes.length, 0);
});
test("private draft made public before upload/verification is retained and never republished", async (t) => {
  const value = await fixture(t);
  const server = provider(value, { before: async (url, init, state) => { if (init.method === "GET" && url.endsWith("/releases/42") && state.release) state.release.draft = false; } });
  await assert.rejects(() => publish(value, server), code("draft")); assert.equal(server.state.writes.length, 2);
});
test("API private asset redirect rejects an unapproved destination without credential leakage", async (t) => {
  const value = await fixture(t); const server = provider(value); const original = server.request; const redirected = [];
  server.request = async (url, init) => { if (url.includes("/releases/assets/")) return new Response(null, { status: 302, headers: { location: "https://example.invalid/private" } }); if (url.includes("example.invalid")) redirected.push(init); return original(url, init); };
  await assert.rejects(() => publish(value, server), code("asset_url")); assert.equal(redirected.length, 0); assert.equal(server.state.published, false);
});
for (const name of assetNames) test(`local per-asset bound applies before allocation: ${name}`, async (t) => {
  const value = await fixture(t); const maximum = { "service-template.tar.gz": limits.archive, "template-candidate.json": limits.descriptor, "template-contract.json": limits.contract, SHA256SUMS: limits.sums }[name];
  await writeFile(join(value.directory, name), Buffer.alloc(maximum + 1)); await assert.rejects(() => inspectCandidateDirectory(value.directory), code("candidate_asset"));
});

test("fixed draft release ID cannot be substituted during private verification", async (t) => {
  const value = await fixture(t); const server = provider(value); const original = server.request;
  server.request = async (url, init) => { const result = await original(url, init); if (init.method === "GET" && url.endsWith("/releases/42") && server.state.release?.assets.length === 4) { const body = await result.json(); body.id = 99; return response(body); } return result; };
  await assert.rejects(() => publish(value, server), code("release_tuple")); assert.equal(server.state.published, false);
});
test("partial private uploaded metadata corruption prevents the next upload", async (t) => {
  const value = await fixture(t);
  const server = provider(value, { before: async (url, init, state) => { if (init.method === "GET" && url.endsWith("/releases/42") && state.release?.assets.length === 1) state.release.assets[0].digest = "sha256:" + "0".repeat(64); } });
  await assert.rejects(() => publish(value, server), code("draft")); assert.equal(server.state.writes.length, 3); assert.equal(server.state.published, false);
});

test("publisher rejects a self-consistent checksum tuple whose held TAR violates owner inventory before network", async (t) => {
  const value = await fixture(t); const server = provider(value);
  const archive = archiveFor(value.bytes["template-contract.json"], Buffer.from("altered member"));
  const candidate = { ...value.candidate, archiveSha256: hash(archive) };
  value.local.bytes = { ...value.local.bytes, "service-template.tar.gz": archive, "template-candidate.json": json(candidate) };
  value.local.bytes.SHA256SUMS = Buffer.from(assetNames.slice(0, 3).map((name) => `${hash(value.local.bytes[name])}  ${name}`).join("\n") + "\n");
  await assert.rejects(() => publish(value, server), code("candidate_archive")); assert.equal(server.state.calls.length, 0);
});
test("publisher applies the actual retained-byte TAR terminal budget before network", async (t) => {
  const value = await fixture(t); const server = provider(value);
  const archive = gzipSync(Buffer.concat([tarMember("README.md", Buffer.from("accepted archive")), tarMember("template-contract.json", value.bytes["template-contract.json"])]));
  const candidate = { ...value.candidate, archiveSha256: hash(archive) };
  value.local.bytes = { ...value.local.bytes, "service-template.tar.gz": archive, "template-candidate.json": json(candidate) };
  value.local.bytes.SHA256SUMS = Buffer.from(assetNames.slice(0, 3).map((name) => `${hash(value.local.bytes[name])}  ${name}`).join("\n") + "\n");
  await assert.rejects(() => publish(value, server), code("candidate_archive")); assert.equal(server.state.calls.length, 0);
});

const rejectedRawRedirects = [
  "//github.com:443/rejected", "//release-assets.githubusercontent.com:443/rejected",
  "//objects.githubusercontent.com:443/rejected", "//github-releases.githubusercontent.com:443/rejected",
  "//user@github.com/rejected", "//user:password@release-assets.githubusercontent.com/rejected",
  "//github.com:444/rejected", "//release-assets.githubusercontent.com:444/rejected",
  "//github.com/rejected#fragment", "//release-assets.githubusercontent.com/rejected#",
  "//example.invalid/rejected", "///github.com:443/rejected",
  "\\github.com:443/rejected",
  " //github.com:443/rejected", "\t//github.com:443/rejected", "https:\t//github.com:443/rejected"
];
for (const location of rejectedRawRedirects) test(`raw redirect authority denied before destination request: ${JSON.stringify(location)}`, async () => {
  const calls = [];
  const request = async (url, init) => { calls.push({ url, init }); assert.equal(init.headers, undefined); return new Response(null, { status: 302, headers: { location } }); };
  await assert.rejects(() => downloadAsset("https://github.com/start", request), code("asset_url"));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://github.com/start");
});
for (const location of rejectedRawRedirects) test(`actual read-only recovery rejects raw authority without writes: ${JSON.stringify(location)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, { existing: {} }); const ordinary = server.request; const downloads = [];
  server.request = async (url, init) => { if (!url.startsWith("https://api.github.com/")) { downloads.push({ url, init }); assert.equal(init.headers, undefined); return new Response(null, { status: 302, headers: { location } }); } return ordinary(url, init); };
  await assert.rejects(() => publish(value, server), code("asset_url")); assert.equal(server.state.writes.length, 0); assert.equal(downloads.length, 1);
});
for (const location of rejectedRawRedirects) test(`actual private headerless continuation rejects raw authority before publish: ${JSON.stringify(location)}`, async (t) => {
  const value = await fixture(t); const server = provider(value, { privateRedirect: true }); const ordinary = server.request; const downloads = [];
  server.request = async (url, init) => { if (!url.startsWith("https://api.github.com/") && !url.startsWith("https://uploads.github.com/")) { downloads.push({ url, init }); assert.equal(init.headers, undefined); return new Response(null, { status: 302, headers: { location } }); } return ordinary(url, init); };
  await assert.rejects(() => publish(value, server), code("asset_url")); assert.equal(server.state.writes.length, 6); assert.equal(downloads.length, 1); assert.equal(server.state.release.draft, true); assert.equal(server.state.published, false);
});
for (const location of ["next", "../next", "/next", "?part=2", "//release-assets.githubusercontent.com/next"]) test(`ordinary relative or valid network-path redirect remains headerless: ${location}`, async () => {
  const calls = []; const expected = new URL(location, "https://github.com/path/start").toString();
  const request = async (url, init) => { calls.push(url); assert.equal(init.headers, undefined); assert.equal(init.redirect, "manual"); return calls.length === 1 ? new Response(null, { status: 302, headers: { location } }) : response(Buffer.from("accepted")); };
  assert.deepEqual(await downloadAsset("https://github.com/path/start", request, 8), Buffer.from("accepted")); assert.deepEqual(calls, ["https://github.com/path/start", expected]);
});
test("actual publisher accepts ordinary relative private and public redirect paths", async (t) => {
  const value = await fixture(t); const server = provider(value, { privateRedirect: true }); const ordinary = server.request; const redirected = new Set(); const destinations = [];
  server.request = async (url, init) => {
    if (url.startsWith("https://github.com/") || url.startsWith("https://release-assets.githubusercontent.com/")) {
      assert.equal(init.headers, undefined);
      if (!redirected.has(url) && !new URL(url).pathname.includes("/accepted/")) { redirected.add(url); return new Response(null, { status: 302, headers: { location: `./accepted/${new URL(url).pathname.split("/").at(-1)}` } }); }
      destinations.push(url);
    }
    return ordinary(url, init);
  };
  assert.equal((await publish(value, server)).mode, "verified"); assert.equal(server.state.writes.length, 7); assert.equal(server.state.published, true); assert.equal(destinations.length, 12);
});

// These invoke the real standalone CLI, including its entrypoint guard, rather
// than only calling the imported validator function.
for (const encoded of [false, true]) test(`workflow CLI validates supplied files through absolute ${encoded ? "URL-encoded" : "ordinary"} paths`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "template-workflow-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, encoded ? "space # percent% unicode-é" : "ordinary");
  await mkdir(folder);
  const script = join(folder, "validate-workflow.mjs");
  const valid = join(folder, "valid # workflow.yml");
  const invalid = join(folder, "invalid % workflow.yml");
  await writeFile(script, await readFile(join(root, "scripts/validate-development-candidate-workflow.mjs")));
  await writeFile(valid, await readFile(join(root, ".github/workflows/development-candidate.yml")));
  await writeFile(invalid, "jobs:\n  invalid:\n    steps: []\n");
  for (const [file, success] of [[valid, true], [invalid, false]]) {
    const result = spawnSync(process.execPath, [script, file], { cwd: directory, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    if (success) { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /development-candidate workflow structure is valid/); }
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /separate bind-candidate and publish-candidate jobs/); assert.doesNotMatch(result.stdout, /structure is valid/); }
  }
  if (process.platform === "win32") assert.match(script, /^[A-Za-z]:\\/);
});
test("workflow validator import with absent entrypoint argv has no CLI side effects", () => {
  const url = pathToFileURL(join(root, "scripts/validate-development-candidate-workflow.mjs")).href;
  const source = `delete process.argv[1]; const module = await import(${JSON.stringify(url)}); if (typeof module.validateWorkflow !== "function") throw new Error("Missing validator export");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: tmpdir(), encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

// Windows-only native .cmd fixtures supply controlled process exits. Actual
// helper bytes, argument order and the Actions epilogue are exercised unchanged.
// Other operating systems retain their existing POSIX gates.
test("standalone Windows native-error preference is false without a profile", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write($PSNativeCommandUseErrorActionPreference)"], { encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.toLowerCase(), "false");
});
for (const helper of ["test", "verify"]) for (const caller of ["standalone", "actions"]) for (const scenario of [
  { name: "first failure stops successor", first: 23, last: 0, calls: 1, exit: 23 },
  { name: "final failure propagates", first: 0, last: 37, calls: 2, exit: 37 },
  { name: "both succeed", first: 0, last: 0, calls: 2, exit: 0 }
]) test(`actual Windows ${helper}.ps1 ${caller}: ${scenario.name}`, { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "template-windows-native-exit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ["scripts", "verify", "runtime/win32", "bin"]) await mkdir(join(directory, path), { recursive: true });
  for (const path of [`scripts/${helper}.ps1`, "service.json", "verify/service-harness.json", "runtime/win32/echo-service.ps1"]) await writeFile(join(directory, path), await readFile(join(root, path)));
  const callsPath = join(directory, "native-calls.txt");
  const stub = join(directory, "bin", "node.cmd");
  await writeFile(stub, '@echo off\r\necho %~1>>"%TEMPLATE_NATIVE_CALLS%"\r\nif "%~1"=="--test" exit /b %TEMPLATE_NATIVE_FIRST%\r\nif "%~1"=="validate-contract" exit /b %TEMPLATE_NATIVE_FIRST%\r\nexit /b %TEMPLATE_NATIVE_LAST%\r\n');
  const script = join(directory, "scripts", `${helper}.ps1`);
  const quoted = script.replaceAll("'", "''");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive"];
  if (caller === "standalone") args.push("-File", script);
  else args.push("-Command", `$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $false; & '${quoted}'; if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`);
  const result = spawnSync("pwsh", args, { cwd: directory, encoding: "utf8", timeout: 15000, env: {
    ...process.env, PATH: `${join(directory, "bin")};${process.env.PATH}`, SERVICE_LASSO_HARNESS_BIN: stub,
    TEMPLATE_NATIVE_CALLS: callsPath, TEMPLATE_NATIVE_FIRST: String(scenario.first), TEMPLATE_NATIVE_LAST: String(scenario.last)
  } });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, scenario.exit, result.stderr);
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
  assert.deepEqual(calls, (helper === "test" ? ["--test", "scripts/validate-development-candidate-workflow.mjs"] : ["validate-contract", "run"]).slice(0, scenario.calls));
  if (helper === "test") {
    if (scenario.exit === 0) assert.match(result.stdout, /Template tests passed \(Windows\)/);
    else assert.doesNotMatch(result.stdout, /Template tests passed/);
  }
});


// Physical CLI identity is tested by actual Node launches, never by rewriting argv
// to the real path before invocation. Directory junctions need no Windows link grant.
for (const encoded of [false, true]) for (const aliasKind of ["directory", "script"]) test(`physical ${aliasKind} alias: workflow and publisher ${encoded ? "encoded" : "ordinary"} paths`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "template-physical-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const physical = join(directory, encoded ? "physical space # percent% é" : "physical");
  const alias = join(directory, encoded ? "alias space # percent% é" : "alias");
  await mkdir(physical);
  for (const name of ["validate-development-candidate-workflow.mjs", "publish-development-candidate.mjs", "verify-template-contract.mjs"]) await writeFile(join(physical, name), await readFile(join(root, "scripts", name)));
  let workflowScript; let publisherScript;
  if (aliasKind === "directory") {
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    workflowScript = join(alias, "validate-development-candidate-workflow.mjs"); publisherScript = join(alias, "publish-development-candidate.mjs");
  } else {
    await mkdir(alias);
    workflowScript = join(alias, "workflow.mjs"); publisherScript = join(alias, "publisher.mjs");
    try {
      await symlink(join(physical, "validate-development-candidate-workflow.mjs"), workflowScript, "file");
      await symlink(join(physical, "publish-development-candidate.mjs"), publisherScript, "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip(`Direct file symbolic links unavailable: ${error.code}; mandatory directory-junction and Windows native gates are separate.`); return; }
      throw error;
    }
  }
  assert.equal(await realpath(workflowScript), await realpath(join(physical, "validate-development-candidate-workflow.mjs")));
  assert.equal(await realpath(publisherScript), await realpath(join(physical, "publish-development-candidate.mjs")));
  assert.notEqual(workflowScript, await realpath(workflowScript));
  if (process.platform === "win32") assert.match(workflowScript, /^[A-Za-z]:\\/);
  const valid = join(directory, "valid # workflow.yml"); const invalid = join(directory, "invalid % workflow.yml");
  await writeFile(valid, await readFile(join(root, ".github/workflows/development-candidate.yml")));
  await writeFile(invalid, "jobs:\n  invalid:\n    steps: []\n");
  for (const [file, success] of [[valid, true], [invalid, false]]) {
    const result = spawnSync(process.execPath, [workflowScript, file], { cwd: directory, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    if (success) { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /development-candidate workflow structure is valid/); assert.equal(result.stderr, ""); }
    else { assert.equal(result.status, 1); assert.match(result.stderr, /separate bind-candidate and publish-candidate jobs/); assert.equal(result.stdout, ""); }
  }
  // The preload observes every actual global fetch attempt; invalid usage must
  // fail before any candidate read/provider authority, even with a token present.
  const denyNetwork = "data:text/javascript," + encodeURIComponent('globalThis.fetch = () => { console.error("UNEXPECTED_NETWORK_ATTEMPT"); throw new Error("Network denied by fixture"); };');
  for (const args of [[], ["unrelated", "missing-candidate"]]) {
    const result = spawnSync(process.execPath, ["--import", denyNetwork, publisherScript, ...args], { cwd: directory, env: { ...process.env, GH_TOKEN: "fixture-no-authority" }, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    const diagnostic = JSON.parse(result.stderr); assert.equal(diagnostic.ok, false); assert.equal(diagnostic.code, "usage"); assert.match(diagnostic.message, /Usage: publish-development-candidate\.mjs publish/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK_ATTEMPT/);
  }
});

for (const name of ["validate-development-candidate-workflow.mjs", "publish-development-candidate.mjs", "verify-template-contract.mjs"]) for (const argvKind of ["absent", "unrelated", "missing"]) for (const withArgs of [false, true]) test(`safe import ${name}: ${argvKind} entrypoint, ${withArgs ? "unrelated" : "absent"} arguments`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "template-safe-import-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = join(directory, "unrelated # runner.mjs");
  const url = pathToFileURL(join(root, "scripts", name)).href;
  const exported = name.startsWith("validate") ? "validateWorkflow" : name.startsWith("publish") ? "createPublisher" : "verifyPublisherArchive";
  const argv = argvKind === "absent" ? "delete process.argv[1];" : argvKind === "missing" ? `process.argv[1] = ${JSON.stringify(join(directory, "missing.mjs"))};` : "";
  await writeFile(runner, `globalThis.fetch = () => { throw new Error("Unexpected imported network authority"); }; ${argv} const module = await import(${JSON.stringify(url)}); if (typeof module[${JSON.stringify(exported)}] !== "function") throw new Error("Missing exported function");`);
  const result = spawnSync(process.execPath, [runner, ...(withArgs ? ["unrelated", "missing-file"] : [])], { cwd: directory, env: { ...process.env, GH_TOKEN: "fixture-no-authority" }, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});
