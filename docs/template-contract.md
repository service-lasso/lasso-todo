# Template contract

`template-contract.json` is the versioned owner policy for projects derived from this repository. The policy digest is SHA-256 over its recursively key-sorted JSON with `contractDigest` omitted. Any inventory, quota, authoring rule, or policy change changes that digest.

The closed inventory records every immutable baseline file as a normalized slash path, SHA-256 and Git-compatible mode. `template-contract.json` is additionally a canonical, byte-identical regular `0644` member of the archive and each derived project. Its digest omits only `contractDigest`, avoiding a self-hash cycle while still binding the complete policy bytes. The verifier checks the canonical template first, then the candidate project. Runtime payloads, scripts, workflows/hooks, provider/dependency manifests, and artifact sources stay byte and mode identical.

Authors may change only declared, closed typed identity fields in `service.json`, the exact GitHub repository URL when their provenance says `github-derived`, and the listed example configuration files. A GitHub-derived provenance record always requires `meta.repository.url` to be its exact declared, typed GitHub URL, including when that field still has the template baseline value. Developer records contain only a bounded `name`; tags are bounded safe strings. Local archive provenance cannot edit a repository URL. Configuration rejects secret-like names/values and source URLs, and its file count and aggregate bytes are separately bounded. All other added files and changed manifest paths are denied.

Each derived project adds `template-provenance.json`. It binds `templateCommit`, template version and contract digest. A `local-archive` origin supplies the exact archive SHA-256 and does not require a GitHub repository. A `github-derived` origin supplies `owner/repository` and must match `meta.repository.url`.

The verifier requires two owner-supplied immutable candidate inputs: the `template-candidate.json` descriptor and the matching `service-template.tar.gz` archive created by `development-template-candidate`. It checks the descriptor against the checked-out template commit and policy, then bounds compressed bytes before decompression and bounds expanded bytes, every accepted TAR record (regular files, directories, and allowed global PAX metadata), and path depth while streaming the tar structure. Only one leading portable Git PAX record is admitted, with the exact `52 comment=<templateCommit>` bytes; expected directory metadata is `0775`, and locked regular files must use the canonical Git archive `0664` or `0775` mode that maps exactly to their policy mode. Every payload hash and Git mode is then checked. Provenance inside a derived project is evidence to be checked; it cannot choose the candidate. Links and all non-regular project objects are denied before the file inventory, allowlist, or content reads.

Run the verifier against an immutable template checkout and the candidate project:

```powershell
node .\scripts\verify-template-contract.mjs --template-root <template-root> --project-root <project-root> --candidate <owner-controlled-template-candidate.json> --candidate-archive <owner-controlled-service-template.tar.gz>
```

Core admission is intentionally outside this repository. The older Core CLI/service-init surface has not implemented this 70-file inventory or candidate provenance protocol, so it is not currently compatible evidence. Core `#1513` and proposal `#1514` / `SPEC-002 AC-4CF.1` must explicitly adopt a compatible parser and curated catalog pin before Core can rely on this result.
