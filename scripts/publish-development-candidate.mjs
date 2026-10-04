import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyPublisherArchive } from "./verify-template-contract.mjs";

export const assetNames = Object.freeze(["service-template.tar.gz", "template-candidate.json", "template-contract.json", "SHA256SUMS"]);
export const limits = Object.freeze({ metadata: 1048576, archive: 262144, descriptor: 4096, contract: 131072, sums: 1024, deadlineMs: 30000 });
const budget = (name) => ({ "service-template.tar.gz": limits.archive, "template-candidate.json": limits.descriptor, "template-contract.json": limits.contract, SHA256SUMS: limits.sums })[name];
const downloadHosts = new Set(["github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com", "release-assets.githubusercontent.com"]);
const fullSha = /^[a-f0-9]{40}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const serialized = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export class PublicationError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fail(code, message) { throw new PublicationError(code, message); }
function exactKeys(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(code, "Unexpected object shape."); }

// Scan raw JSON first: JSON.parse alone silently accepts repeated object keys.
export function parseBoundedJson(bytes, maximum = limits.metadata) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) fail("bounds", "JSON exceeds raw-byte limit.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("json", "Invalid UTF-8 JSON."); }
  let at = 0;
  const ws = () => { while (/[\t\r\n ]/.test(text[at] || "x")) at += 1; };
  const string = () => { const start = at++; while (at < text.length) { const c = text[at++]; if (c === '"') { try { return JSON.parse(text.slice(start, at)); } catch { fail("json", "Invalid JSON string."); } } if (c === "\\") at += 1; } fail("json", "Unterminated JSON string."); };
  const value = (depth) => {
    if (depth > 32) fail("bounds", "JSON exceeds depth limit.");
    ws(); const c = text[at];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      const object = c === "{"; const close = object ? "}" : "]"; const keys = new Set(); at += 1; ws();
      if (text[at] === close) { at += 1; return; }
      for (;;) {
        if (object) { ws(); if (text[at] !== '"') fail("json", "Missing object key."); const key = string(); if (keys.has(key)) fail("duplicate_json", "Repeated JSON object key."); keys.add(key); ws(); if (text[at++] !== ":") fail("json", "Missing colon."); }
        value(depth + 1); ws(); const next = text[at++]; if (next === close) return; if (next !== ",") fail("json", "Invalid container delimiter.");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!match) fail("json", "Invalid JSON value."); at += match[0].length;
  };
  value(0); ws(); if (at !== text.length) fail("json", "Trailing JSON bytes.");
  try { return JSON.parse(text); } catch { fail("json", "Invalid JSON."); }
}

export function parseCandidate(bytes) {
  const value = parseBoundedJson(bytes, limits.descriptor);
  exactKeys(value, ["archiveSha256", "contractDigest", "contractSha256", "kind", "releaseTag", "schemaVersion", "templateCommit", "templateVersion"], "candidate");
  if (value.schemaVersion !== 1 || value.kind !== "development-template-candidate" || !fullSha.test(value.templateCommit) || ![value.archiveSha256, value.contractDigest, value.contractSha256].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) || typeof value.templateVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(value.templateVersion) || value.templateVersion.length > 64 || value.releaseTag !== `template-v${value.templateVersion}-${value.templateCommit}` || !bytes.equals(serialized(value))) fail("candidate", "Malformed or noncanonical descriptor.");
  return value;
}

async function regularBytes(path, maximum) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail("candidate_asset", "Candidate file is nonregular or oversized.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || info.dev !== before.dev || info.ino !== before.ino) fail("candidate_asset", "Candidate file changed during open.");
    const output = Buffer.alloc(info.size); let offset = 0;
    while (offset < output.length) { const { bytesRead } = await handle.read(output, offset, output.length - offset, offset); if (!bytesRead) fail("candidate_asset", "Candidate file truncated."); offset += bytesRead; }
    const extra = Buffer.alloc(1); if ((await handle.read(extra, 0, 1, offset)).bytesRead) fail("bounds", "Candidate file grew beyond accepted size.");
    const after = await handle.stat();
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail("candidate_asset", "Candidate file changed during read.");
    return output;
  } finally { await handle.close(); }
}

function bindBytes(input) {
  const bytes = Object.fromEntries(assetNames.map((name) => { const body = input[name]; if (!Buffer.isBuffer(body) || body.length > budget(name)) fail("bounds", "Missing or oversized candidate asset."); return [name, Buffer.from(body)]; }));
  const candidate = parseCandidate(bytes["template-candidate.json"]);
  const policy = parseBoundedJson(bytes["template-contract.json"], limits.contract);
  const unsigned = { ...policy }; delete unsigned.contractDigest;
  if (hash(JSON.stringify(canonical(unsigned))) !== policy.contractDigest) fail("candidate_binding", "Policy digest does not bind the raw owner contract.");
  if (!bytes["template-contract.json"].equals(serialized(policy)) || policy.contractDigest !== candidate.contractDigest || policy.templateVersion !== candidate.templateVersion || !Number.isSafeInteger(policy.quotas?.maximumArchiveBytes) || policy.quotas.maximumArchiveBytes <= 0 || policy.quotas.maximumArchiveBytes > limits.archive || bytes["service-template.tar.gz"].length > policy.quotas.maximumArchiveBytes || hash(bytes["service-template.tar.gz"]) !== candidate.archiveSha256 || hash(bytes["template-contract.json"]) !== candidate.contractSha256) fail("candidate_binding", "Candidate contract/archive binding failed.");
  const sums = bytes.SHA256SUMS.toString("utf8");
  const expected = assetNames.slice(0, 3).map((name) => `${hash(bytes[name])}  ${name}`).join("\n") + "\n";
  if (sums !== expected) fail("sums", "Checksum manifest must use the closed canonical inventory.");
  return { candidate, bytes, digests: Object.fromEntries(assetNames.map((name) => [name, hash(bytes[name])])) };
}
export async function inspectCandidateDirectory(directory) { return bindBytes(Object.fromEntries(await Promise.all(assetNames.map(async (name) => [name, await regularBytes(join(directory, name), budget(name))])))); }

function strictUrl(url, hosts) {
  let parsed; try { parsed = new URL(url); } catch { fail("asset_url", "Invalid URL."); }
  // Reject explicit default ports too; URL.port alone normalizes :443 away.
  const authority = /^https:\/\/([^/?#]+)/.exec(url)?.[1];
  if (!authority || authority.includes(":") || authority.includes("@") || parsed.protocol !== "https:" || !hosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.hash || url.includes("#")) fail("asset_url", "URL violates fixed HTTPS origin grammar.");
  return parsed;
}

async function boundedRequest(request, url, options, maximum, deadlineMs) {
  const controller = new AbortController(); let timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PublicationError("deadline", "Request/body deadline exceeded.")); }, deadlineMs); });
  let reader;
  try {
    return await Promise.race([timedOut, (async () => {
      const response = await request(url, { ...options, redirect: "manual", signal: controller.signal });
      if (controller.signal.aborted) fail("deadline", "Request completed after its deadline.");
      if (response.status >= 300 && response.status < 400) return { response, bytes: null };
      const size = response.headers.get("content-length");
      if (size !== null && (!/^(0|[1-9][0-9]*)$/.test(size) || Number(size) > maximum)) fail("bounds", "Response Content-Length exceeds bounds.");
      if (!response.body?.getReader) fail("stream", "Response must expose a bounded stream.");
      reader = response.body.getReader(); const chunks = []; let total = 0;
      for (;;) { if (controller.signal.aborted) fail("deadline", "Body deadline exceeded."); const next = await reader.read(); if (controller.signal.aborted) fail("deadline", "Body completed after its deadline."); if (next.done) break; if (!(next.value instanceof Uint8Array) || next.value.byteLength > maximum - total) fail("bounds", "Response stream exceeds bounds."); total += next.value.byteLength; chunks.push(Buffer.from(next.value)); }
      return { response, bytes: Buffer.concat(chunks, total) };
    })()]);
  } finally { clearTimeout(timer); controller.abort(); if (reader) Promise.resolve(reader.cancel()).catch(() => {}); }
}

export async function downloadAsset(url, request = fetch, maximum = limits.archive, deadlineMs = limits.deadlineMs) {
  let current = strictUrl(url, downloadHosts).toString(); const deadline = Date.now() + deadlineMs;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const remaining = deadline - Date.now(); if (remaining <= 0) fail("deadline", "Download deadline exceeded.");
    const { response, bytes } = await boundedRequest(request, current, {}, maximum, remaining);
    if (response.status >= 300 && response.status < 400) { const location = response.headers.get("location"); if (!location) fail("download", "Redirect lacks location."); if (location !== location.trim() || /[\u0000-\u001f\u007f\\]/.test(location) || location.includes("#")) fail("asset_url", "Raw redirect violates URL grammar."); if (location.startsWith("//")) strictUrl(`https:${location}`, downloadHosts); else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) strictUrl(location, downloadHosts); current = strictUrl(new URL(location, current).toString(), downloadHosts).toString(); continue; }
    if (!response.ok) fail("download", "Public asset request failed."); return bytes;
  }
  fail("download", "Redirect budget exceeded.");
}

export function assertEnvironment(environment, ref) {
  if (ref !== "refs/heads/develop") fail("ref", "Publisher requires refs/heads/develop.");
  if (!Array.isArray(environment?.protection_rules) || !environment.protection_rules.length || environment.deployment_branch_policy?.protected_branches !== true || environment.deployment_branch_policy?.custom_branch_policies !== false) fail("environment", "Protected environment/branch deployment policy required.");
}
export function assertImmutableReleases(configuration) { if (configuration?.enabled !== true) fail("immutable_releases", "Immutable releases must be enabled."); }
const positiveId = (id) => Number.isSafeInteger(id) && id > 0;
function releaseAssets(release, repository, local, draft, expectedIds) {
  const candidate = local.candidate;
  if (!positiveId(release?.id) || release.tag_name !== candidate.releaseTag || release.target_commitish !== candidate.templateCommit || release.prerelease !== true || release.draft !== draft || (!draft && release.immutable !== true) || !Array.isArray(release.assets) || release.assets.length !== assetNames.length) fail("release_tuple", "Release is not the complete exact candidate tuple.");
  const assets = new Map(); const ids = new Set();
  for (const asset of release.assets) {
    if (!asset || !assetNames.includes(asset.name) || assets.has(asset.name) || !positiveId(asset.id) || ids.has(asset.id)) fail("release_tuple", "Asset names/IDs must be exact and unique.");
    if (asset.url !== `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(candidate.releaseTag)}/${encodeURIComponent(asset.name)}` || asset.digest !== `sha256:${local.digests[asset.name]}` || asset.size !== local.bytes[asset.name].length || (expectedIds && expectedIds[asset.name] !== asset.id)) fail("release_tuple", "Asset identity/digest/size changed.");
    ids.add(asset.id); assets.set(asset.name, asset);
  }
  return assets;
}
export function assertReleaseTuple(release, repository, local, downloaded) {
  const assets = releaseAssets(release, repository, local, false);
  for (const name of assetNames) if (!Buffer.isBuffer(downloaded?.[name]) || !downloaded[name].equals(local.bytes[name])) fail("download", "Public bytes differ from accepted buffers.");
  return { tag: local.candidate.releaseTag, commit: local.candidate.templateCommit, releaseId: release.id, assetIds: assetNames.map((name) => assets.get(name).id) };
}

// Called only after the state machine has checked private and public held bytes.
// This projection is observed publication metadata, never role catalog authority.
function publicationProjection(release, repository, local) {
  const assets = releaseAssets(release, repository, local, false);
  return {
    repository, releaseId: release.id, tag: release.tag_name,
    targetCommit: release.target_commitish, draft: release.draft,
    prerelease: release.prerelease, immutable: release.immutable,
    assets: [...assetNames].sort().map(name => ({
      id: assets.get(name).id, name, url: assets.get(name).url,
      size: local.bytes[name].length, sha256: local.digests[name],
    })),
  };
}

// Only this adapter supplies network authority; caller-controlled provider URLs are never used.
export function createPublisher({ request = fetch, token, repository, ref, sha, ownerContractBytes, deadlineMs = limits.deadlineMs }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || repository.split("/").some((part) => part === "." || part === "..") || !fullSha.test(sha || "") || ref !== "refs/heads/develop" || typeof token !== "string" || !token || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > limits.deadlineMs) fail("usage", "Invalid publisher inputs.");
  const base = `https://api.github.com/repos/${repository}`;
  if (!Buffer.isBuffer(ownerContractBytes) || ownerContractBytes.length > limits.contract) fail("candidate_binding", "Exact checked-out owner contract bytes are required.");
  const ownerContract = Buffer.from(ownerContractBytes);
  const api = async (path, { method = "GET", value, optional = false, binary = false, maximum = limits.metadata } = {}) => {
    const url = `${base}${path}`; strictUrl(url, new Set(["api.github.com"]));
    const started = Date.now();
    const { response, bytes } = await boundedRequest(request, url, { method, headers: { accept: binary ? "application/octet-stream" : "application/vnd.github+json", authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "content-type": "application/json" }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }, maximum, deadlineMs);
    if (binary && response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); const remaining = deadlineMs - (Date.now() - started);
      if (!location || remaining <= 0) fail("download", "Private asset redirect lacks bounded download.");
      strictUrl(location, downloadHosts);
      return downloadAsset(location, request, maximum, remaining);
    }
    if (optional && response.status === 404) return null;
    if (!response.ok || (response.status >= 300 && response.status < 400)) fail("api", "Fixed authenticated API request failed; no mutation retry.");
    return binary ? bytes : parseBoundedJson(bytes, maximum);
  };
  const policy = async () => {
    assertImmutableReleases(await api("/immutable-releases"));
    assertEnvironment(await api("/environments/development-candidate"), ref);
    const branch = await api("/branches/develop"); const protection = await api("/branches/develop/protection");
    if (branch?.protected !== true || branch.commit?.sha !== sha || !protection || typeof protection !== "object" || Array.isArray(protection)) fail("branch", "Protected develop must remain at exact source SHA.");
  };
  const tagPath = (tag) => `/git/ref/tags/${encodeURIComponent(tag)}`;
  const proveTag = async (tag) => {
    const record = await api(tagPath(tag));
    if (record?.ref !== `refs/tags/${tag}`) fail("tag", "Fixed tag ref identity mismatch.");
    let object = record.object; const seen = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (!object || !fullSha.test(object.sha || "") || !["tag", "commit"].includes(object.type) || seen.has(object.sha)) fail("tag", "Tag object is invalid or cyclic.");
      seen.add(object.sha);
      if (object.type === "commit") { if (object.sha !== sha) fail("tag", "Tag does not resolve to source SHA."); return object.sha; }
      const annotated = await api(`/git/tags/${object.sha}`); if (annotated.sha !== object.sha) fail("tag", "Annotated tag object identity changed."); object = annotated.object;
    }
    fail("tag", "Tag dereference budget exceeded.");
  };
  const getRelease = (tag) => api(`/releases/tags/${encodeURIComponent(tag)}`, { optional: true });
  const verify = async (release, local, draft, ids, expectedReleaseId = release?.id) => {
    if (release?.id !== expectedReleaseId) fail("release_tuple", "Fixed release ID changed before verification.");
    const assets = releaseAssets(release, repository, local, draft, ids);
    await proveTag(local.candidate.releaseTag);
    for (const name of assetNames) {
      const asset = assets.get(name);
      const body = draft ? await api(`/releases/assets/${asset.id}`, { binary: true, maximum: local.bytes[name].length }) : await downloadAsset(asset.browser_download_url, request, local.bytes[name].length, deadlineMs);
      if (!body.equals(local.bytes[name])) fail("download", "Provider bytes differ from accepted held buffer; retained unpublished state.");
    }
    const after = await api(`/releases/${release.id}`);
    const refreshed = releaseAssets(after, repository, local, draft, ids);
    if (after.id !== release.id || assetNames.some((name) => refreshed.get(name).id !== assets.get(name).id)) fail("release_tuple", "Release changed during verification.");
    await proveTag(local.candidate.releaseTag);
    return after;
  };
  const absent = async (local) => {
    if (await getRelease(local.candidate.releaseTag) || await api(tagPath(local.candidate.releaseTag), { optional: true })) fail("collision", "Preexisting release/tag cannot be reused for a new publication.");
  };
  const mutate = async (path, options) => { await policy(); return api(path, options); };
  return { async publish(input) {
    // Copy once before awaits; uploads never reopen paths or borrow caller-owned buffers.
    const local = bindBytes(input.bytes); if (sha !== local.candidate.templateCommit) fail("sha", "Candidate/source mismatch.");
    if (!local.bytes["template-contract.json"].equals(ownerContract)) fail("candidate_binding", "Artifact policy differs from the exact checked-out owner contract.");
    await verifyPublisherArchive(local.bytes["service-template.tar.gz"], ownerContract, local.candidate);
    await policy(); const existing = await getRelease(local.candidate.releaseTag);
    if (existing) { const recovered = await verify(existing, local, false); return { mode: "recovered", releaseId: recovered.id, tag: local.candidate.releaseTag, commit: sha, publication: publicationProjection(recovered, repository, local) }; }
    await absent(local);
    // Recheck absence after the literal before-write policy read. Creation never updates a ref.
    await policy(); await absent(local); await policy();
    await api("/git/refs", { method: "POST", value: { ref: `refs/tags/${local.candidate.releaseTag}`, sha } });
    await proveTag(local.candidate.releaseTag);
    if (await getRelease(local.candidate.releaseTag)) fail("collision", "Release appeared after tag creation.");
    const draft = await mutate("/releases", { method: "POST", value: { tag_name: local.candidate.releaseTag, target_commitish: sha, name: `Development template candidate ${local.candidate.templateVersion} (${sha})`, draft: true, prerelease: true, body: "Checksum-bound development candidate; publication does not prove Core adoption, CLI authoring or GA." } });
    if (!positiveId(draft?.id) || draft.draft !== true || draft.prerelease !== true || draft.tag_name !== local.candidate.releaseTag || draft.target_commitish !== sha || !Array.isArray(draft.assets) || draft.assets.length) fail("draft", "Create did not yield the expected empty private draft.");
    const ids = {};
    for (const name of assetNames) {
      await proveTag(local.candidate.releaseTag);
      const current = await api(`/releases/${draft.id}`);
      if (current.draft !== true || current.id !== draft.id || current.tag_name !== local.candidate.releaseTag || current.target_commitish !== sha || !Array.isArray(current.assets) || current.assets.length !== Object.keys(ids).length || current.assets.some((asset) => ids[asset.name] !== asset.id)) fail("draft", "Private draft changed before upload.");
      const priorNames = new Set();
      for (const asset of current.assets) {
        if (priorNames.has(asset.name) || asset.url !== `${base}/releases/assets/${asset.id}` || asset.size !== local.bytes[asset.name]?.length || asset.digest !== `sha256:${local.digests[asset.name]}` || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(local.candidate.releaseTag)}/${encodeURIComponent(asset.name)}`) fail("draft", "Uploaded private asset metadata changed before next write.");
        priorNames.add(asset.name);
      }
      await policy();
      const url = `https://uploads.github.com/repos/${repository}/releases/${draft.id}/assets?name=${encodeURIComponent(name)}`;
      strictUrl(url, new Set(["uploads.github.com"]));
      const { response, bytes } = await boundedRequest(request, url, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/octet-stream" }, body: Buffer.from(local.bytes[name]) }, limits.metadata, deadlineMs);
      if (!response.ok || response.status >= 300) fail("upload", "Asset upload failed; retain draft and do not retry.");
      const asset = parseBoundedJson(bytes); if (asset.name !== name || !positiveId(asset.id) || Object.values(ids).includes(asset.id)) fail("upload", "Upload asset identity is invalid."); ids[name] = asset.id;
    }
    await verify(await api(`/releases/${draft.id}`), local, true, ids, draft.id);
    // Re-read policies first, then reverify the entire private tuple immediately before the single transition.
    await policy(); await verify(await api(`/releases/${draft.id}`), local, true, ids, draft.id); await policy();
    const published = await api(`/releases/${draft.id}`, { method: "PATCH", value: { draft: false } });
    if (published.id !== draft.id) fail("release_tuple", "Publish changed release identity.");
    const final = await verify(published, local, false, ids);
    const byTag = await getRelease(local.candidate.releaseTag); if (byTag?.id !== final.id) fail("release_tuple", "Final tag/release identity mismatch.");
    releaseAssets(byTag, repository, local, false, ids);
    return { mode: "verified", tag: local.candidate.releaseTag, commit: sha, releaseId: final.id, assetIds: assetNames.map((name) => ids[name]), publication: publicationProjection(byTag, repository, local) };
  } };
}

async function main() {
  const [mode, directory, repository, ref, sha] = process.argv.slice(2);
  if (mode !== "publish" || !directory) fail("usage", "Usage: publish-development-candidate.mjs publish <candidate-dir> <owner/repo> <ref> <full-sha>");
  const local = await inspectCandidateDirectory(directory);
  const ownerContractBytes = await regularBytes(join(process.cwd(), "template-contract.json"), limits.contract);
  console.log(JSON.stringify(await createPublisher({ token: process.env.GH_TOKEN, repository, ref, sha, ownerContractBytes }).publish(local)));
}
// Node ESM resolves filesystem aliases; argv retains the invocation spelling.
// Resolve both sides so imports remain safe even with unrelated/missing argv.
function isCliEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch { return false; }
}
if (isCliEntrypoint()) main().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || "internal", message: error.message })); process.exitCode = 1; });
