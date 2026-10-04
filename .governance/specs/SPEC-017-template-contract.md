# SPEC-017 — versioned template admission contract

Status: active

## Intent

Define an owner-controlled, machine-verifiable contract for projects created from `service-template`.

## Requirements

- `AC-17.1`: A versioned JSON policy has a closed normalized file inventory containing path, SHA-256 digest and Git mode for every immutable baseline file, plus explicit quotas. The canonical policy file is itself a regular, byte-identical `0644` contract member in both the immutable archive and the derived project; its digest excludes only its self-referential `contractDigest` field.
- `AC-17.2`: Contract verification binds the policy version and canonical policy digest to project provenance, rejects malformed provenance, and never approves changed runtime, scripts, hooks, provider/dependency declarations or artifact sources. It rejects links and every non-regular object before excluded-path, inventory, or allowlist treatment; reserved tool directories may be excluded only when their root object is an actual non-link directory, and their contents are outside the project admission inventory. It rejects archives whose compressed size, expanded size, entry count, path depth, member type, member mode, member bytes, or terminal structure exceed the declared limits before reading a member payload. A valid archive ends with exactly two 512-byte zero blocks, followed only by zero padding.
- `AC-17.3`: Only declared service identity and safe metadata/configuration differences are admitted. Each editable manifest field has a closed type, value, size and nested-key rule. Arbitrary commands, URLs, secret values, unknown manifest fields, and local-archive repository URL edits are rejected. A GitHub-derived repository URL is permitted only when it exactly matches approved provenance and also satisfies its declared type, byte-size, and pattern rule.
- `AC-17.4`: A local author-created project remains admissible with the template archive digest. A GitHub-derived identity is required only when provenance says it is GitHub-derived.
- `AC-17.5`: Tests exercise the real template inventory plus valid, altered, forbidden and malformed project fixtures, policy-file byte/mode substitution, typed manifest-container attacks, reserved-name file/directory link denials with truthful platform skips, and archive quota and terminal-structure denials.

## External dependency boundary

Core proposal `#1514` / `SPEC-002 AC-4CF.1` and Core `#1513` are reference material only. This policy is owned by `service-template`; Core must explicitly adopt a compatible parser and catalog pin before it may use this policy for admission.
