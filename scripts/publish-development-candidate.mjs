import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { basename, join } from "node:path";

const assetNames = ["service-template.tar.gz", "template-candidate.json", "template-contract.json", "SHA256SUMS"];
const checksummedAssetNames = assetNames.filter((name) => name !== "SHA256SUMS");
const downloadHosts = new Set(["github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com", "release-assets.githubusercontent.com"]);

export class PublicationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { throw new PublicationError(code, message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(code, "Object has an unexpected shape.");
}

export function parseCandidate(bytes) {
  let value;
  try { value = JSON.parse(bytes); } catch { fail("candidate", "Candidate descriptor is not JSON."); }
  exactKeys(value, ["archiveSha256", "contractDigest", "contractSha256", "kind", "releaseTag", "schemaVersion", "templateCommit", "templateVersion"], "candidate");
  if (value.schemaVersion !== 1 || value.kind !== "development-template-candidate" || !/^[a-f0-9]{40}$/.test(value.templateCommit) || !/^[a-f0-9]{64}$/.test(value.archiveSha256) || !/^[a-f0-9]{64}$/.test(value.contractDigest) || !/^[a-f0-9]{64}$/.test(value.contractSha256) || typeof value.templateVersion !== "string" || value.releaseTag !== `template-v${value.templateVersion}-${value.templateCommit}`) fail("candidate", "Candidate descriptor is malformed.");
  return value;
}

async function regularBytes(path, code) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(code, `Candidate asset is not a regular file: ${basename(path)}.`);
  return readFile(path);
}

function parseSums(bytes) {
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.length !== checksummedAssetNames.length) fail("sums", "SHA256SUMS must contain exactly the three non-manifest candidate assets.");
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || entries.has(match[2])) fail("sums", "SHA256SUMS has malformed or duplicate entries.");
    entries.set(match[2], match[1]);
  }
  if ([...entries.keys()].sort().join(",") !== [...checksummedAssetNames].sort().join(",")) fail("sums", "SHA256SUMS must name exactly the three non-manifest candidate assets.");
  return entries;
}

export async function inspectCandidateDirectory(directory) {
  const bytes = Object.fromEntries(await Promise.all(assetNames.map(async (name) => [name, await regularBytes(join(directory, name), "candidate_asset")] )));
  const candidate = parseCandidate(bytes["template-candidate.json"]);
  if (sha256(bytes["service-template.tar.gz"]) !== candidate.archiveSha256 || sha256(bytes["template-contract.json"]) !== candidate.contractSha256) fail("candidate_binding", "Local candidate assets do not bind the descriptor.");
  let policy;
  try { policy = JSON.parse(bytes["template-contract.json"]); } catch { fail("candidate_binding", "Raw template contract is not JSON."); }
  if (policy?.contractDigest !== candidate.contractDigest || policy?.templateVersion !== candidate.templateVersion) fail("candidate_binding", "Raw template contract does not bind the descriptor.");
  const sums = parseSums(bytes.SHA256SUMS);
  for (const name of checksummedAssetNames) if (sums.get(name) !== sha256(bytes[name])) fail("sums", `SHA256SUMS does not bind ${name}.`);
  return { candidate, bytes, digests: Object.fromEntries(assetNames.map((name) => [name, sha256(bytes[name])])) };
}

function expectedUrl(repository, tag, name) { return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`; }
function assertDownloadUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { fail("asset_url", "Release asset URL is invalid."); }
  if (parsed.protocol !== "https:" || !downloadHosts.has(parsed.hostname)) fail("asset_url", "Release asset URL is outside the allowlisted GitHub download hosts.");
  return parsed;
}

export function assertEnvironment(environment, ref) {
  if (ref !== "refs/heads/develop") fail("ref", "Development candidate publication requires refs/heads/develop.");
  if (!environment || typeof environment !== "object" || !Array.isArray(environment.protection_rules) || environment.protection_rules.length === 0 || environment.deployment_branch_policy?.protected_branches !== true || environment.deployment_branch_policy?.custom_branch_policies !== false) fail("environment", "The protected development-candidate environment and protected-branch policy are required before publication.");
}

export function assertImmutableReleases(configuration) {
  if (configuration?.enabled !== true) fail("immutable_releases", "Repository immutable releases must be enabled before any tag or release mutation.");
}

export function assertReleaseTuple(release, repository, local, downloaded) {
  const { candidate, digests } = local;
  if (!release || release.tag_name !== candidate.releaseTag || release.target_commitish !== candidate.templateCommit || release.prerelease !== true || release.draft !== false || release.immutable !== true || !Array.isArray(release.assets) || release.assets.length !== assetNames.length) fail("release_tuple", "Existing release is not the exact immutable development-candidate tuple.");
  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== "string" || !Number.isSafeInteger(asset.id) || asset.id <= 0 || assets.has(asset.name) || !asset.browser_download_url) fail("release_tuple", "Release assets are malformed.");
    assets.set(asset.name, asset);
  }
  if ([...assets.keys()].sort().join(",") !== [...assetNames].sort().join(",")) fail("release_tuple", "Release has missing, additional, or renamed assets.");
  for (const name of assetNames) {
    const asset = assets.get(name);
    if (asset.digest !== `sha256:${digests[name]}` || asset.browser_download_url !== expectedUrl(repository, candidate.releaseTag, name)) fail("release_tuple", `Release does not bind the expected ${name} asset.`);
    const body = downloaded?.[name];
    if (!Buffer.isBuffer(body) || sha256(body) !== digests[name]) fail("download", `Downloaded ${name} bytes do not match the locally bound SHA-256.`);
  }
  return { tag: candidate.releaseTag, commit: candidate.templateCommit, assetIds: assetNames.map((name) => assets.get(name).id) };
}

export function recoverOrCreate({ immutableReleases, environment, ref, sha, repository, local, release, downloaded }) {
  assertImmutableReleases(immutableReleases);
  assertEnvironment(environment, ref);
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== local.candidate.templateCommit) fail("sha", "Workflow SHA does not match the candidate descriptor.");
  if (release == null) return { mode: "create", tag: local.candidate.releaseTag };
  return { mode: "recovered", ...assertReleaseTuple(release, repository, local, downloaded) };
}

async function api(url) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN || ""}` } });
  if (!response.ok) fail("api", `GitHub API preflight failed with HTTP ${response.status}.`);
  return response.json();
}

async function apiOptionalRelease(url) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN || ""}` } });
  if (response.status === 404) return null;
  if (!response.ok) fail("api", `GitHub API release lookup failed with HTTP ${response.status}.`);
  return response.json();
}

export async function downloadAsset(url, request = fetch) {
  let current = assertDownloadUrl(url).toString();
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await request(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) fail("download", "GitHub asset redirect did not provide a location.");
      current = assertDownloadUrl(new URL(location, current).toString()).toString();
      continue;
    }
    if (!response.ok) fail("download", `GitHub asset download failed with HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  }
  fail("download", "GitHub asset download exceeded the redirect limit.");
}

async function readback(repository, local) {
  const tag = encodeURIComponent(local.candidate.releaseTag);
  const release = await api(`https://api.github.com/repos/${repository}/releases/tags/${tag}`);
  const downloaded = Object.fromEntries(await Promise.all(assetNames.map(async (name) => {
    const asset = release.assets?.find((item) => item.name === name);
    return [name, asset ? await downloadAsset(asset.browser_download_url) : null];
  })));
  return assertReleaseTuple(release, repository, local, downloaded);
}

async function main() {
  const [mode, directory, repository, ref, sha] = process.argv.slice(2);
  if (!new Set(["preflight", "readback"]).has(mode) || !directory || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !ref || !sha) fail("usage", "Usage: publish-development-candidate.mjs <preflight|readback> <candidate-dir> <owner/repo> <ref> <full-sha>");
  const local = await inspectCandidateDirectory(directory);
  if (mode === "readback") { console.log(JSON.stringify({ mode: "verified", ...await readback(repository, local) })); return; }
  const [immutableReleases, environment] = await Promise.all([api(`https://api.github.com/repos/${repository}/immutable-releases`), api(`https://api.github.com/repos/${repository}/environments/development-candidate`)]);
  const release = await apiOptionalRelease(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(local.candidate.releaseTag)}`);
  let downloaded;
  if (release) downloaded = Object.fromEntries(await Promise.all(assetNames.map(async (name) => {
    const asset = release.assets?.find((item) => item.name === name);
    return [name, asset ? await downloadAsset(asset.browser_download_url) : null];
  })));
  console.log(JSON.stringify(recoverOrCreate({ immutableReleases, environment, ref, sha, repository, local, release, downloaded })));
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) main().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || "internal", message: error.message })); process.exitCode = 1; });
