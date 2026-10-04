# Lasso Todo

GitHub-generated from `service-lasso/service-template`; `template-origin.json` records the exact develop provenance. This repository owns the real `todo` service used in the progressive tutorials.

Use Node22+, then `npm ci`, `npm test`, `npm run package`, `npm run verify`. The template package/test/verify `.ps1`/`.sh` entrypoints are adapted for Todo. Fresh archive verification exercises actual HTTP, invalid input and restart persistence. Core-managed lifecycle is independent evidence.

`service.json` declares managed `@node`, acquired `${SERVICE_ARTIFACT_ROOT}/runtime/server.mjs`, allocated web/UI endpoints and HTTP health. Platform archives contain runtime, UI and locked SQL driver dependencies; retained JSON data stays at `${SERVICE_ROOT}/data/todos.json`, outside acquired artifacts. No retained workspace or Echo sample is packaged.

Import a published candidate by explicit tag using Core `services import service-lasso/lasso-todo --tag <tag>` in the tutorial inventory, then Install/Configure/Start through Admin. Stop Todo before changing dependencies. After PostgreSQL is installed, `node scripts/configure-stage.mjs <installed-todo-directory> postgres` adds the dependency and migrates saved IDs at the next managed start. After installing `todo-api`, use the same command with `api`. Reload discovery after manifest changes. Existing data is retained.

This is an isolated loopback learning app without user authentication. Admin operator sign-in does not authenticate Todo users. Public SQL defaults are for local learning only.

CI checks native package consumers on Windows/Linux/macOS. Explicit `release.yml` dispatch on develop with publish=true produces a development prerelease after gates pass, with platform assets, manifest, checksums and source/run identity. No GA or upstream template admission/publisher qualification is implied.

## Inherited template links

The following upstream links describe the starting template; this service's active scope is SPEC-TODO / issue#1.

Turn an existing program into a service that Lasso can install, configure, start, check, and package.

**[Create your service from this template](https://github.com/service-lasso/service-lasso/blob/develop/docs/components/service-template/bootstrap-new-service-repo.md)**

Use GitHub's **Use this template** button, rename the sample, replace its runtime payload, and describe it in `service.json`.

Validate your first package:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/package.ps1
pwsh -NoLogo -NoProfile -File ./scripts/test.ps1
```

[Write the manifest](https://github.com/service-lasso/service-lasso/blob/develop/docs/components/service-template/service-json-reference.md) · [Package it](https://github.com/service-lasso/service-lasso/blob/develop/docs/components/service-template/packaging.md) · [Validate it](https://github.com/service-lasso/service-lasso/blob/develop/docs/components/service-template/validation.md)

Want an application with ready-made dependencies? Start with [PostgreSQL and a small app](https://github.com/service-lasso/service-lasso/blob/develop/docs/first-useful-service.md) or an [app template](https://github.com/service-lasso/service-lasso/blob/develop/docs/reference-apps.md).

Reader guides live in Service Lasso. [Maintainer context](docs/maintainer-context.md) and implementation specs stay with the code.
