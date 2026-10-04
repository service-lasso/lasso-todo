import { readFile } from "node:fs/promises";

export function validateWorkflow(source) {
  const lines = source.split(/\r?\n/);
  const jobs = [];
  let inJobs = false;
  let currentJob = null;
  let stepIndent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs || !line.trim() || line.trimStart().startsWith("#")) continue;
    const job = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) { currentJob = { name: job[1], steps: [], permissions: null, environment: null, if: null }; jobs.push(currentJob); stepIndent = -1; continue; }
    if (!currentJob) continue;
    if (/^    steps:\s*$/.test(line)) { stepIndent = 6; continue; }
    const permission = /^    permissions:\s*$/.test(line);
    if (permission) { const next = lines[index + 1] || ""; const match = /^      contents:\s+(read|write)\s*$/.exec(next); if (!match) throw new Error("Job permissions must contain an indented contents scope."); currentJob.permissions = match[1]; continue; }
    const environment = /^    environment:\s+([A-Za-z0-9_-]+)\s*$/.exec(line); if (environment) { currentJob.environment = environment[1]; continue; }
    const condition = /^    if:\s+(.+)$/.exec(line); if (condition) { currentJob.if = condition[1]; continue; }
    if (stepIndent > 0 && /^      - (?:name: )?(.+)$/.test(line)) currentJob.steps.push(line.trim());
    if (stepIndent > 0 && /^        uses:\s+(.+)$/.test(line)) currentJob.steps.push(line.trim());
  }
  const bind = jobs.find((job) => job.name === "bind-candidate");
  const publish = jobs.find((job) => job.name === "publish-candidate");
  if (!bind || !publish || jobs.length !== 2) throw new Error("Workflow must have separate bind-candidate and publish-candidate jobs.");
  if (bind.permissions !== "read" || publish.permissions !== "write") throw new Error("Only publish-candidate may have contents: write.");
  if (publish.environment !== "development-candidate" || !publish.if?.includes("workflow_dispatch") || !publish.if.includes("refs/heads/develop")) throw new Error("Publication must use the protected development-candidate environment and develop-only manual condition.");
  if (!bind.steps.some((step) => step.includes("actions/upload-artifact@v4")) || !publish.steps.some((step) => step.includes("actions/download-artifact@v4"))) throw new Error("Publication must consume the bound artifact from a separate job.");
  if (!bind.steps.some((step) => step.includes("rhysd/actionlint:1.7.7"))) throw new Error("The host Actions validator must validate this workflow.");
  if (!publish.steps.some((step) => step.includes("Preflight immutable publication")) || !publish.steps.some((step) => step.includes("Read back immutable published tuple"))) throw new Error("Publication must preflight and read back the immutable tuple.");
  return { jobs: jobs.map((job) => ({ name: job.name, permissions: job.permissions, environment: job.environment, if: job.if, steps: job.steps.length })) };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const file = process.argv[2] || ".github/workflows/development-candidate.yml";
  validateWorkflow(await readFile(file, "utf8"));
  console.log("development-candidate workflow structure is valid");
}
