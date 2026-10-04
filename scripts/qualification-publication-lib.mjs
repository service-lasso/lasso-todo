import { isDeepStrictEqual } from "node:util";
import { assertByteRef, assertRun, assertScope, assertSource, closed, digest, parseScopedJson, REQUIRED_GA_PLATFORMS } from "./ga-platform-scope-lib.mjs";

// Prospective source admission only. Neither wrapper contents nor fixture bytes
// enroll a candidate, catalog entry or native proof implementation.
export const TEMPLATE_ROLE_ADMISSIONS = Object.freeze([]);
export const TEMPLATE_NATIVE_PROOF_READERS = Object.freeze([]);
const roles = Object.freeze([
  { role: "cli-canonical-authoring", repository: "service-lasso/service-lasso-cli", ids: Array.from({ length: 12 }, (_, i) => `TC${String(i + 1).padStart(2, "0")}`) },
  { role: "core-source-admission", repository: "service-lasso/service-lasso", ids: Array.from({ length: 8 }, (_, i) => `CA${String(i + 1).padStart(2, "0")}`) },
]);
const candidateKeys = ["releaseTag", "templateCommit", "templateVersion", "archiveSha256", "contractDigest", "contractSha256"];
const rowKeys = ["role", "repository", "commit", "templateCommit", "archiveSha256", "contractDigest", "contractSha256", "policySha256", "catalogIdentity", "catalogSource", "platforms", "gates", "receipts", "outcome"];
const outcome = value => { if (!["success", "failure", "blocked"].includes(value)) throw new Error("unknown template evidence outcome"); };
const aggregate = (values, missing) => values.includes("failure") ? "failure" : missing || values.includes("blocked") ? "blocked" : "success";
const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value);
function refs(rows) {
  if (!Array.isArray(rows)) throw new Error("template receipt list absent");
  const identities = new Map();
  let previous = "";
  for (const row of rows) {
    closed(row, ["platform", "jobId", "runId", "runAttempt", "workflowSha", "name", "sha256", "size"], "template receipt");
    assertByteRef({ name: row.name, sha256: row.sha256, size: row.size });
    assertRun({ id: row.runId, attempt: row.runAttempt, workflowSha: row.workflowSha });
    const platform = REQUIRED_GA_PLATFORMS.indexOf(row.platform);
    const order = `${platform}:${row.name}`;
    if (platform < 0 || !Number.isSafeInteger(row.jobId) || row.jobId < 1 || order <= previous || identities.has(row.jobId)) throw new Error("template receipt order/identity differs");
    identities.set(row.jobId, row); previous = order;
  }
  return rows;
}
function union(gates) {
  const byJob = new Map(), byName = new Map();
  for (const gate of gates) for (const ref of gate.receipts) {
    for (const old of [byJob.get(ref.jobId), byName.get(ref.name)]) if (old && !isDeepStrictEqual(old, ref)) throw new Error("conflicting template retained refs");
    byJob.set(ref.jobId, ref); byName.set(ref.name, ref);
  }
  return [...byJob.values()].sort((a, b) => REQUIRED_GA_PLATFORMS.indexOf(a.platform) - REQUIRED_GA_PLATFORMS.indexOf(b.platform) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function candidate(value) {
  closed(value, candidateKeys, "template candidate");
  for (const key of candidateKeys) {
    const field = value[key];
    if (field === null) continue;
    if (key === "templateCommit" ? !hex(field, 40) : key.endsWith("Sha256") || key === "contractDigest" ? !hex(field, 64) : typeof field !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(field)) throw new Error("template candidate field invalid");
  }
  if (value.templateVersion !== null && (value.templateVersion.length > 64 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/u.test(value.templateVersion))) throw new Error("template candidate version invalid");
  if (value.templateCommit !== null && value.templateVersion !== null && value.releaseTag !== null && value.releaseTag !== `template-v${value.templateVersion}-${value.templateCommit}`) throw new Error("template candidate tag differs");
}
function publication(value, tuple) {
  if (value === null) return;
  closed(value, ["repository", "releaseId", "tag", "targetCommit", "draft", "prerelease", "immutable", "assets"], "template publication");
  if (value.repository !== "service-lasso/service-template" || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1 || !hex(value.targetCommit, 40) || typeof value.tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value.tag) || ![value.draft, value.prerelease, value.immutable].every(v => typeof v === "boolean") || !Array.isArray(value.assets) || value.assets.length > 4) throw new Error("template publication identity invalid");
  if (tuple.templateCommit !== null && tuple.templateCommit !== value.targetCommit || tuple.releaseTag !== null && tuple.releaseTag !== value.tag) throw new Error("template candidate/publication mismatch");
  let previous = ""; const ids = new Set();
  for (const asset of value.assets) {
    closed(asset, ["id", "name", "url", "size", "sha256"], "template publication asset");
    assertByteRef({ name: asset.name, size: asset.size, sha256: asset.sha256 });
    if (!["SHA256SUMS", "service-template.tar.gz", "template-candidate.json", "template-contract.json"].includes(asset.name) || asset.name <= previous || !Number.isSafeInteger(asset.id) || asset.id < 1 || ids.has(asset.id) || asset.url !== `https://api.github.com/repos/${value.repository}/releases/assets/${asset.id}`) throw new Error("template publication asset differs");
    if (asset.name === "service-template.tar.gz" && tuple.archiveSha256 !== null && asset.sha256 !== tuple.archiveSha256 || asset.name === "template-contract.json" && tuple.contractSha256 !== null && asset.sha256 !== tuple.contractSha256) throw new Error("template publication raw tuple differs");
    previous = asset.name; ids.add(asset.id);
  }
}

export function createBlockedTemplateEvidence(source, scope, run) {
  const value = { schema: "service-lasso.template-qualification-publication.v1", scope, source, candidate: Object.fromEntries(candidateKeys.map(key => [key, null])), publication: null, run, consumers: roles.map(role => ({ role: role.role, repository: role.repository, commit: null, templateCommit: null, archiveSha256: null, contractDigest: null, contractSha256: null, policySha256: scope.policySha256, catalogIdentity: null, catalogSource: null, platforms: [...REQUIRED_GA_PLATFORMS], gates: role.ids.map(id => ({ id, outcome: "blocked", receipts: [] })), receipts: [], outcome: "blocked" })), outcome: "blocked" };
  return validateTemplateEvidence(value, source);
}
export function readTemplateEvidence(bytes, source, held = new Map()) {
  return validateTemplateEvidence(parseScopedJson(bytes, "original template qualification wrapper"), source, held);
}
export function validateTemplateEvidence(value, source, held = new Map()) {
  closed(value, ["schema", "scope", "source", "candidate", "publication", "run", "consumers", "outcome"], "template wrapper");
  if (value.schema !== "service-lasso.template-qualification-publication.v1") throw new Error("template wrapper version differs");
  assertScope(value.scope); assertSource(value.source, source); assertRun(value.run); outcome(value.outcome);
  if (source.repository !== "service-lasso/service-template" || source.ref !== "refs/heads/develop" || value.run.workflowSha !== source.commit) throw new Error("template wrapper source differs");
  candidate(value.candidate); publication(value.publication, value.candidate);
  if (value.candidate.templateCommit !== null && value.candidate.templateCommit !== source.commit) throw new Error("template candidate source differs");
  if (!Array.isArray(value.consumers) || value.consumers.length !== 2) throw new Error("template fixed roles missing");
  value.consumers.forEach((row, index) => {
    const role = roles[index]; closed(row, rowKeys, "template consumer"); outcome(row.outcome);
    if (row.role !== role.role || row.repository !== role.repository || row.policySha256 !== value.scope.policySha256 || !isDeepStrictEqual(row.platforms, REQUIRED_GA_PLATFORMS) || !Array.isArray(row.gates) || !isDeepStrictEqual(row.gates.map(gate => gate.id), role.ids)) throw new Error("template role/gates differ");
    for (const key of ["commit", "templateCommit", "archiveSha256", "contractDigest", "contractSha256"]) if (row[key] !== null && !hex(row[key], key.endsWith("Commit") || key === "commit" ? 40 : 64)) throw new Error("template consumer binding invalid");
    for (const key of ["templateCommit", "archiveSha256", "contractDigest", "contractSha256"]) if (row[key] !== null && row[key] !== value.candidate[key]) throw new Error("template consumer tuple differs");
    if (row.catalogIdentity !== null && (typeof row.catalogIdentity !== "string" || Buffer.byteLength(row.catalogIdentity) > 256 || row.catalogIdentity.length === 0 || /[\x00-\x1f\x7f]/u.test(row.catalogIdentity))) throw new Error("template catalog identity invalid");
    if (row.catalogSource !== null || row.catalogIdentity !== null) throw new Error("template production role admission remains empty");
    for (const gate of row.gates) {
      closed(gate, ["id", "outcome", "receipts"], "template gate"); outcome(gate.outcome); refs(gate.receipts);
      if (gate.receipts.length !== 0) throw new Error("template retained proof body reader remains unimplemented");
      for (const ref of gate.receipts) {
        const bytes = held.get(ref.name);
        if (ref.workflowSha !== row.commit || !Buffer.isBuffer(bytes) || bytes.length !== ref.size || digest(bytes) !== ref.sha256) throw new Error("template original retained proof missing/different");
      }
      // No source-approved private body grammar/producer exists in this unit.
      if (gate.outcome === "success") throw new Error("template native proof reader admission remains empty");
      if (gate.outcome === "failure" && gate.receipts.length === 0) throw new Error("template failure lacks observed retained proof");
    }
    refs(row.receipts);
    if (!isDeepStrictEqual(row.receipts, union(row.gates))) throw new Error("template consumer receipt union differs");
    const missing = rowKeys.some(key => row[key] === null);
    if (row.outcome !== aggregate(row.gates.map(gate => gate.outcome), missing)) throw new Error("template row outcome precedence differs");
  });
  const missing = Object.values(value.candidate).some(v => v === null) || value.publication === null || value.publication.draft || !value.publication.prerelease || !value.publication.immutable || value.publication.assets.length !== 4;
  const observedPublicationFailure = value.publication !== null && (value.publication.draft || !value.publication.prerelease || !value.publication.immutable || value.publication.assets.length !== 4);
  if (value.outcome !== aggregate([...value.consumers.map(row => row.outcome), ...(observedPublicationFailure ? ["failure"] : [])], missing)) throw new Error("template wrapper outcome precedence differs");
  return value;
}
