import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectCandidateDirectory, recoverOrCreate, assertReleaseTuple, downloadAsset, PublicationError } from "../scripts/publish-development-candidate.mjs";
import { validateWorkflow } from "../scripts/validate-development-candidate-workflow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = await readFile(join(root, ".github", "workflows", "development-candidate.yml"), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function candidateFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "development-candidate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = Buffer.from("bound archive");
  const contract = Buffer.from(JSON.stringify({ templateVersion: "1.0.0-dev", contractDigest: "c".repeat(64) }) + "\n");
  const candidate = { schemaVersion: 1, kind: "development-template-candidate", templateCommit: "a".repeat(40), templateVersion: "1.0.0-dev", contractDigest: "c".repeat(64), archiveSha256: hash(archive), contractSha256: hash(contract), releaseTag: `template-v1.0.0-dev-${"a".repeat(40)}` };
  const descriptor = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
  const assets = { "service-template.tar.gz": archive, "template-candidate.json": descriptor, "template-contract.json": contract };
  assets.SHA256SUMS = Buffer.from(["service-template.tar.gz", "template-candidate.json", "template-contract.json"].map((name) => `${hash(assets[name])}  ${name}`).join("\n") + "\n");
  for (const [name, value] of Object.entries(assets)) await writeFile(join(directory, name), value);
  return { directory, candidate, assets, local: await inspectCandidateDirectory(directory) };
}

function releaseFor(value, overrides = {}) {
  return { tag_name: value.candidate.releaseTag, target_commitish: value.candidate.templateCommit, prerelease: true, draft: false, immutable: true, assets: Object.keys(value.assets).map((name, index) => ({ id: index + 1, name, digest: `sha256:${value.local.digests[name]}`, browser_download_url: `https://github.com/service-lasso/service-template/releases/download/${value.candidate.releaseTag}/${encodeURIComponent(name)}` })), ...overrides };
}

test("workflow has a valid two-job Actions structure", () => {
  const parsed = validateWorkflow(workflow);
  assert.deepEqual(parsed.jobs.map((job) => [job.name, job.permissions]), [["bind-candidate", "read"], ["publish-candidate", "write"]]);
  assert.throws(() => validateWorkflow(workflow.replace("      contents: write", "        contents: write")), /indented contents scope/);
});

test("publication preflight fails before mutation when repository or environment controls are absent", async (t) => {
  const value = await candidateFixture(t);
  const args = { ref: "refs/heads/develop", sha: value.candidate.templateCommit, repository: "service-lasso/service-template", local: value.local, release: null };
  assert.throws(() => recoverOrCreate({ ...args, immutableReleases: { enabled: false }, environment: { protection_rules: [{}], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } }), (error) => error instanceof PublicationError && error.code === "immutable_releases");
  assert.throws(() => recoverOrCreate({ ...args, immutableReleases: { enabled: true }, environment: { protection_rules: [], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } }), (error) => error instanceof PublicationError && error.code === "environment");
  assert.throws(() => recoverOrCreate({ ...args, immutableReleases: { enabled: true }, environment: { protection_rules: [{}], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, ref: "refs/heads/feature/17" }), (error) => error instanceof PublicationError && error.code === "ref");
});

test("only a complete immutable exact tuple can recover an interrupted publication", async (t) => {
  const value = await candidateFixture(t);
  const configuration = { immutableReleases: { enabled: true }, environment: { protection_rules: [{ type: "required_reviewers" }], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, ref: "refs/heads/develop", sha: value.candidate.templateCommit, repository: "service-lasso/service-template", local: value.local };
  assert.equal(recoverOrCreate({ ...configuration, release: null }).mode, "create");
  assert.equal(recoverOrCreate({ ...configuration, release: releaseFor(value), downloaded: value.assets }).mode, "recovered");
  assert.throws(() => recoverOrCreate({ ...configuration, release: releaseFor(value, { immutable: false }), downloaded: value.assets }), /exact immutable/);
  assert.throws(() => recoverOrCreate({ ...configuration, release: releaseFor(value, { assets: releaseFor(value).assets.slice(0, 3) }), downloaded: value.assets }), /exact immutable/);
  assert.throws(() => assertReleaseTuple(releaseFor(value), configuration.repository, value.local, { ...value.assets, "service-template.tar.gz": Buffer.from("changed") }), (error) => error instanceof PublicationError && error.code === "download");
});

test("candidate inventory refuses a raw descriptor, checksum, or policy substitution", async (t) => {
  const value = await candidateFixture(t);
  await writeFile(join(value.directory, "SHA256SUMS"), "a".repeat(64) + "  service-template.tar.gz\n");
  await assert.rejects(() => inspectCandidateDirectory(value.directory), (error) => error instanceof PublicationError && error.code === "sums");
});

test("remote asset download follows only allowlisted redirects without authorization headers", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { status: 302, headers: new Headers({ location: "https://release-assets.githubusercontent.com/release-asset" }) };
    return { status: 200, ok: true, arrayBuffer: async () => Buffer.from("downloaded") };
  };
  assert.deepEqual(await downloadAsset("https://github.com/service-lasso/service-template/releases/download/tag/service-template.tar.gz", request), Buffer.from("downloaded"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options), [{ redirect: "manual" }, { redirect: "manual" }]);
  const rejectedCalls = [];
  await assert.rejects(() => downloadAsset("https://github.com/service-lasso/service-template/releases/download/tag/service-template.tar.gz", async (url, options) => {
    rejectedCalls.push({ url, options });
    return { status: 302, headers: new Headers({ location: "https://example.invalid/release-asset" }) };
  }), (error) => error instanceof PublicationError && error.code === "asset_url");
  assert.deepEqual(rejectedCalls, [{ url: "https://github.com/service-lasso/service-template/releases/download/tag/service-template.tar.gz", options: { redirect: "manual" } }]);
});
