import { readTemplateEvidence } from "./qualification-publication-lib.mjs";
import { sourceIdentity } from "./ga-platform-scope-lib.mjs";
import { isEntrypoint, readHeld } from "./qualification-cli-lib.mjs";

export async function verifyQualificationPublication(path, commit) {
  return readTemplateEvidence(await readHeld(path), sourceIdentity(commit, "service-lasso/service-template"));
}
if (isEntrypoint(import.meta.url)) {
  try {
    const [path, commit, ...extra] = process.argv.slice(2);
    if (!path || !commit || extra.length) throw new Error("Usage: verify-qualification-publication.mjs <retained-json> <expected-full-sha>");
    const value = await verifyQualificationPublication(path, commit);
    console.log(JSON.stringify({ outcome: value.outcome, eligibility: value.outcome === "success" }));
    if (value.outcome !== "success") process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
