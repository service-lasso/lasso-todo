# Service Lasso service template

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
