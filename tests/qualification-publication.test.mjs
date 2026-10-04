import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBlockedTemplateEvidence, readTemplateEvidence, validateTemplateEvidence, TEMPLATE_ROLE_ADMISSIONS, TEMPLATE_NATIVE_PROOF_READERS } from "../scripts/qualification-publication-lib.mjs";
import { scopeIdentity, sourceIdentity } from "../scripts/ga-platform-scope-lib.mjs";
import { produceQualificationPublication } from "../scripts/produce-qualification-publication.mjs";

const commit = "a".repeat(40), source = sourceIdentity(commit, "service-lasso/service-template");
const blocked = () => createBlockedTemplateEvidence(source, scopeIdentity(), { id: 7, attempt: 2, workflowSha: commit });
const bytes = value => Buffer.from(JSON.stringify(value));
test("actual producer retains two complete roles and admits no production proofs", async () => {
  const value = await produceQualificationPublication({ GITHUB_REPOSITORY: source.repository, GITHUB_REF: source.ref, GITHUB_SHA: commit, GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "2" });
  assert.deepEqual(value, blocked());
  assert.deepEqual(TEMPLATE_ROLE_ADMISSIONS, []); assert.deepEqual(TEMPLATE_NATIVE_PROOF_READERS, []);
  assert.deepEqual(value.consumers.map(row => row.gates.length), [12, 8]);
  assert.equal(readTemplateEvidence(bytes(value), source).outcome, "blocked");
  await assert.rejects(() => produceQualificationPublication({ GITHUB_REPOSITORY: source.repository, GITHUB_REF: "refs/heads/other" }), /develop/);
});
const mutations = [
  ["version", v => v.schema = "service-lasso.template-qualification-publication.v0"],
  ["extra key", v => v.privateBody = "secret"],
  ["policy", v => v.scope.policySha256 = "b".repeat(64)],
  ["policy source", v => v.scope.policySource.blob = "b".repeat(40)],
  ["source", v => v.source.commit = "b".repeat(40)],
  ["attempt", v => v.run.attempt = 0],
  ["workflow", v => v.run.workflowSha = "b".repeat(40)],
  ["candidate source", v => v.candidate.templateCommit = "b".repeat(40)],
  ["candidate version", v => v.candidate.templateVersion = "unknown"],
  ["candidate version bounds", v => v.candidate.templateVersion = "1.0.0-" + "a".repeat(64)],
  ["candidate tag", v => { v.candidate.templateCommit = commit; v.candidate.templateVersion = "1.0.0-dev"; v.candidate.releaseTag = "other"; }],
  ["third role", v => v.consumers.push(structuredClone(v.consumers[0]))],
  ["gate missing", v => v.consumers[0].gates.pop()],
  ["gate duplicate", v => v.consumers[0].gates[1].id = "TC01"],
  ["Darwin", v => v.consumers[0].platforms.push("darwin")],
  ["catalog identity", v => v.consumers[0].catalogIdentity = "fixture"],
  ["catalog source", v => v.consumers[0].catalogSource = { repository: v.consumers[0].repository }],
  ["gate success", v => v.consumers[0].gates[0].outcome = "success"],
  ["failure without observed proof", v => { v.consumers[0].gates[0].outcome = "failure"; v.consumers[0].outcome = "failure"; v.outcome = "failure"; }],
  ["row success", v => v.consumers[0].outcome = "success"],
  ["wrapper success", v => v.outcome = "success"],
  ["wrapper fake failure", v => v.outcome = "failure"],
];
for (const [name, mutate] of mutations) test(`actual strict reader denies ${name}`, () => { const v = blocked(); mutate(v); assert.throws(() => readTemplateEvidence(bytes(v), source)); });
test("raw duplicate and oversized wrapper denied before parse", () => {
  assert.throws(() => readTemplateEvidence(Buffer.from('{"schema":1,"schema":2}'), source), /Repeated/);
  assert.throws(() => readTemplateEvidence(Buffer.alloc(1048577), source), /budget/);
});
test("nonempty direct reference cannot manufacture an absent native body reader", () => {
  const v = blocked(), row = v.consumers[0]; row.commit = commit;
  const ref = { platform: "win32", jobId: 1, runId: 7, runAttempt: 2, workflowSha: commit, name: "native.json", sha256: "b".repeat(64), size: 1 };
  row.gates[0].receipts = [ref]; row.receipts = [ref];
  assert.throws(() => validateTemplateEvidence(v, source, new Map([[ref.name, Buffer.from("x")]])), /body reader/);
});
test("observed partial publication failure dominates missing consumers", () => {
  const v = blocked();
  v.publication = { repository: source.repository, releaseId: 8, tag: "actual-observed-tag", targetCommit: commit, draft: true, prerelease: true, immutable: false, assets: [] };
  assert.throws(() => validateTemplateEvidence(v, source), /precedence/);
  v.outcome = "failure"; assert.equal(readTemplateEvidence(bytes(v), source).outcome, "failure");
  v.publication.assets = [{ id: 1, name: "unknown", url: "https://api.github.com/repos/service-lasso/service-template/releases/assets/1", size: 1, sha256: "b".repeat(64) }];
  assert.throws(() => validateTemplateEvidence(v, source), /asset differs/);
});
test("actual retained verifier entrypoint denies blocked eligibility", async t => {
  const root = await mkdtemp(join(tmpdir(), "template-scoped-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "wrapper.json"); await writeFile(path, bytes(blocked()));
  const script = fileURLToPath(new URL("../scripts/verify-qualification-publication.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, path, commit], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stdout), { outcome: "blocked", eligibility: false });
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../scripts/produce-qualification-publication.mjs", import.meta.url).href)}); await import(${JSON.stringify(new URL("../scripts/verify-qualification-publication.mjs", import.meta.url).href)});`], { encoding: "utf8" });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
});
