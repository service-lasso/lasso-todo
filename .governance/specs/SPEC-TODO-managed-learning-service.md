# Template-derived Todo learning service

Issue #1; coordinated Core #1666 / SPEC-002 AC-4AJ.7/.8. Status: Development.

- TODO-1: GitHub records service-lasso/service-template as template_repository. Generated develop is the sole bootstrap input. Record template develop SHA and tree, generated develop SHA and tree; matching tree is additional evidence, not a substitute for GitHub provenance.
- TODO-2: Own service.json, loopback Node UI/API and service-local JSON. Depend on managed @node, use allocated web endpoint, HTTP readiness and graceful managed stop. Create/list input is bounded and browser titles are rendered as text.
- TODO-3: Preserve IDs while migrating to managed PostgreSQL, then proxying to a separately managed Go API; dependency outages are explicit and recovery retains data.
- TODO-4: Adapt template package.ps1/package.sh, test.ps1/test.sh, verify.ps1/verify.sh, manifest and service-harness contract for the actual Todo payload. Package only runtime and locked driver dependencies, never retained application data, credentials or upstream sample providers. Verify fresh archive extraction, real HTTP, invalid input and restart persistence; Core-managed execution is separate direct evidence.
- TODO-5: CI runs package/consumer checks on declared platforms, produces checksum-bound platform assets, and keeps publication explicitly dispatched from develop as a development service candidate. No automatic promotion-branch trigger or GA declaration.
- TODO-6: README and tutorials teach template origin, manifest, build/package, registration/acquisition and lifecycle, not an embedded Core helper. Use protected releases only after the exact candidate succeeds; otherwise report an explicit publication gap.

The copied SPEC-017/018, template-contract.json and template admission/publisher tests are upstream baseline reference material. Their upstream approvals, held producer work and runtime-admission qualification do not transfer to Todo. This service adaptation does not execute or claim that upstream producer/admission programme. TODO-1–6 govern Todo source and packaged consumer verification; replacing Echo-specific starter assertions requires explicit adaptation review and direct Todo evidence.
