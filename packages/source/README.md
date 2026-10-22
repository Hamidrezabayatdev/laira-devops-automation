# @laira/source — bounded static source inspection

This package is an in-memory archive validation and static-analysis boundary. It does **not** install dependencies, execute scripts or configuration, run builds/tests/hooks, fetch repositories, call a model, or deploy code.

## Contracts

- `ingestSourceArchive(bytes, 'zip' | 'tar.gz', limits?)` validates an archive and returns a bounded candidate-file inventory and digest of the original bytes.
- `analyzeSourceFiles(files)` returns bounded manifest/dependency/environment-name/port inference. Results are labelled `static_inference`, never observed runtime facts. Manifest `valid: null` means recognition by file name only, not syntax validation. For JSON manifests, `valid: true` establishes JSON-object syntax only—not a complete ecosystem schema check or deployability.
- `validateSourcePath` rejects ambiguous and unsafe paths before extraction could occur. No filesystem extraction is used.
- Errors are static `SourceImportError` codes; do not expose parser errors or source content in application logs.

Default limits: 50 MiB archive, 256 MiB expanded data, 10,000 entries, 1 MiB retained per file, 16 MiB total retained candidate source. Overrides may reduce limits only. Oversized candidate files are counted but omitted from analysis. Nested archives, dependencies/build output and recognized sensitive paths are excluded rather than expanded. TAR support deliberately accepts a strict USTAR subset and rejects PAX/GNU metadata extensions instead of silently bypassing entry counting. ZIP filename support is deliberately strict (ASCII or explicitly flagged valid UTF-8); other encodings are rejected rather than silently reinterpreted.

## Trust boundaries

**Candidate source is untrusted and may still contain credentials or prompt injection.** A path deny-list is not a secret scanner. Do not log inventory bytes, send them automatically to a model, treat them as instructions, or use this inventory as a deployment-ready bundle. Recognized secret paths are excluded, but arbitrary files can contain secrets. Dependency names and inferred environment variable names are not proof of compatibility or completeness.

This package alone does not implement authenticated upload, persistence, private-source access, retention, GitHub commit resolution, durable import jobs, or deployment. Those require separately reviewed workspace-scoped integration and lifecycle recovery. Raw archives may contain secret-bearing excluded entries and must never be passed wholesale to a model or deployment builder.

See `IMPLEMENTATION-PLAN.md` for the broader import/deployment boundary and the project acceptance docs for evidence and limitations.
