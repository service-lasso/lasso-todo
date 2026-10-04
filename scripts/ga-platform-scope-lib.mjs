import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseBoundedJson } from "./publish-development-candidate.mjs";

export const REQUIRED_GA_PLATFORMS = Object.freeze(["win32", "linux"]);
export const POLICY_REFERENCE = Object.freeze({
  repository: "service-lasso/service-lasso",
  commit: "a0384e676c1b2dbf66b915563ea70c176c09d598",
  path: ".governance/project/ga-platform-scope.json",
  blob: "e694c3e314c1bf11e03dc4656730a96467a765b8",
});
export const POLICY_SHA256 = "159d644c161cf532c94d3bfe17ed55e32bf94c5d2843928945c450f6d8140c12";
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function closed(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label}: closed schema mismatch`);
}
export function parseScopedJson(bytes, label = "scoped evidence") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024) throw new Error(`${label}: byte budget`);
  return parseBoundedJson(bytes, 1024 * 1024);
}
export function scopeIdentity() {
  return { policyId: "ga-windows-linux-2026-10-04", policySha256: POLICY_SHA256, policySource: { ...POLICY_REFERENCE }, requiredPlatforms: [...REQUIRED_GA_PLATFORMS], deferredPlatforms: ["darwin"] };
}
export function assertScope(scope) {
  closed(scope, ["policyId", "policySha256", "policySource", "requiredPlatforms", "deferredPlatforms"], "scope");
  closed(scope.policySource, ["repository", "commit", "path", "blob"], "policy source");
  if (!isDeepStrictEqual(scope, scopeIdentity())) throw new Error("scope: unapproved immutable policy identity");
  return scope;
}
export async function readSourceScope() {
  const location = new URL(`../${POLICY_REFERENCE.path}`, import.meta.url), info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024) throw new Error("source policy: bounded regular Git bytes required");
  const bytes = await readFile(location);
  if (bytes.length !== info.size) throw new Error("source policy: held byte count changed");
  if (digest(bytes) !== POLICY_SHA256 || createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") !== POLICY_REFERENCE.blob) throw new Error("source policy: original Git bytes mismatch");
  const policy = parseScopedJson(bytes, "source policy");
  closed(policy, ["schema", "policyId", "ownerDecision", "requiredPlatforms", "deferredPlatforms", "requirementsRevision"], "policy");
  closed(policy.ownerDecision, ["date", "issue", "authority"], "owner decision");
  closed(policy.requirementsRevision, ["repository", "commit", "path"], "requirements revision");
  if (policy.schema !== "service-lasso.ga-platform-scope.v1" || policy.policyId !== scopeIdentity().policyId || !isDeepStrictEqual(policy.requiredPlatforms, REQUIRED_GA_PLATFORMS) || !isDeepStrictEqual(policy.deferredPlatforms, ["darwin"])) throw new Error("source policy: invalid canonical schema");
  return scopeIdentity();
}
export function assertPolicyEnvironment(env = process.env) {
  if (env.SCOPE_POLICY_SHA256 !== POLICY_SHA256) throw new Error("scope policy assertion differs from source");
}
export function assertDevelopIdentity(env = process.env) {
  if (env.GITHUB_REF !== "refs/heads/develop" || !/^[a-f0-9]{40}$/u.test(env.CANDIDATE_SHA ?? env.QUALIFICATION_CANDIDATE_SHA ?? "")) throw new Error("scoped route requires exact develop source context");
}
export function sourceIdentity(commit, repository = POLICY_REFERENCE.repository) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("source: full lowercase commit required");
  return { repository, commit, ref: "refs/heads/develop" };
}
export function assertSource(source, expected) {
  closed(source, ["repository", "commit", "ref"], "source");
  if (!isDeepStrictEqual(source, expected) || !/^[a-f0-9]{40}$/u.test(source.commit) || source.ref !== "refs/heads/develop") throw new Error("source identity mismatch");
}
export function assertByteRef(value) {
  closed(value, ["name", "sha256", "size"], "byte reference");
  if (typeof value.name !== "string" || value.name.length > 240 || !/^[A-Za-z0-9._/-]+$/u.test(value.name) || value.name.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 256 * 1024 * 1024) throw new Error("byte reference invalid");
}
export function assertRun(run) {
  closed(run, ["id", "attempt", "workflowSha"], "run");
  if (![run.id, run.attempt].every(value => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{40}$/u.test(run.workflowSha)) throw new Error("run identity invalid");
}
export function assertReceiptRefs(receipts) {
  if (!Array.isArray(receipts) || receipts.length !== 2) throw new Error("exact two platform receipts required");
  const jobs = new Set(), names = new Set();
  receipts.forEach((receipt, index) => {
    closed(receipt, ["platform", "jobId", "runId", "runAttempt", "workflowSha", "name", "sha256", "size"], "receipt");
    assertByteRef({ name: receipt.name, sha256: receipt.sha256, size: receipt.size });
    assertRun({ id: receipt.runId, attempt: receipt.runAttempt, workflowSha: receipt.workflowSha });
    if (receipt.platform !== REQUIRED_GA_PLATFORMS[index] || !Number.isSafeInteger(receipt.jobId) || receipt.jobId < 1 || jobs.has(receipt.jobId) || names.has(receipt.name)) throw new Error("receipt target/job inventory invalid");
    jobs.add(receipt.jobId); names.add(receipt.name);
  });
}
