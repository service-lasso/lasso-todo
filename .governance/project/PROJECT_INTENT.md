# Service Template intent

`service-template` is the canonical, owner-controlled baseline for Service Lasso service packages. Its immutable runtime, scripts, hooks, providers, dependency declarations and artifact source rules must be mechanically distinguishable from the limited identity and safe configuration metadata that a service author may change.

Development candidates must be reviewable and checksum-bound. Release, promotion and deployment remain separate decisions.

The issue #17 publisher holds accepted bytes through private draft upload and verification, checks provider policy before every mutation, and proves the final tag-to-source and immutable public tuple. A failed partial publication remains retained evidence; source changes do not prove publication, Core adoption or CLI authoring acceptance.

Windows helper gates propagate every native failure immediately; all three CLIs recognize physical entrypoint identity while remaining silent safe imports. Source and subprocess regression coverage remain unexecuted pending independent entire review and fresh input admission.
