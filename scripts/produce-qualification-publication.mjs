import { writeFile } from "node:fs/promises";
import { createBlockedTemplateEvidence } from "./qualification-publication-lib.mjs";
import { readSourceScope, sourceIdentity } from "./ga-platform-scope-lib.mjs";
import { isEntrypoint } from "./qualification-cli-lib.mjs";

// No caller-selected consumer proofs/catalogs. The actual role producers do not
// yet exist, so absence is retained explicitly and cannot become qualification.
export async function produceQualificationPublication(env = process.env) {
  if (env.GITHUB_REPOSITORY !== "service-lasso/service-template" || env.GITHUB_REF !== "refs/heads/develop") throw new Error("exact Template develop context required");
  const source = sourceIdentity(env.GITHUB_SHA, env.GITHUB_REPOSITORY);
  const run = { id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), workflowSha: source.commit };
  return createBlockedTemplateEvidence(source, await readSourceScope(), run);
}
if (isEntrypoint(import.meta.url)) {
  try {
    const [destination, ...extra] = process.argv.slice(2);
    if (!destination || extra.length) throw new Error("Usage: produce-qualification-publication.mjs <new-retained-json>");
    const value = await produceQualificationPublication();
    await writeFile(destination, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ outcome: value.outcome, eligibility: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
