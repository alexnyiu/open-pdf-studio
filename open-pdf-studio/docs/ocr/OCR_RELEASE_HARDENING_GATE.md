# OCR release-hardening gate

The authoritative feature-readiness gate is a protected pull request into
`main`. Pushes to `ocr-release-hardening` run the same verification so failures
are visible before the pull request is opened. Their final evaluator runs in
explicit local-diagnostic mode and always records `MACOS OCR RELEASE HARDENING
NO-GO`; the expected diagnostic exit is non-blocking for the push workflow. A
branch push can therefore never create an authoritative release approval.

## Required checks

Configure the `main` branch rule to require an up-to-date branch, at least one
approving review, and these exact GitHub check names:

- `Static verification`
- `Desktop build (ubuntu-22.04)`
- `Desktop build (windows-latest)`
- `Desktop build (macos-26)`
- `macOS packaged editor acceptance`
- `save/render coherence report verification`
- `macOS editor and OCR performance`
- `macOS OCR release-hardening decision`

“Exact” is intentional: missing checks and additional legacy required checks
both fail repository-controls validation. This keeps the documented release
contract identical to the settings GitHub enforces.

Branch protection is repository state. A checkout and workflow file cannot
enable or prove that setting. CI reads the active rules for `main` and validates
them without attempting to mutate repository settings. When no ruleset governs
`main`, CI may fall back only to the classic branch-protection endpoint. That
endpoint requires a repository secret named `REPOSITORY_CONTROLS_TOKEN` whose
credential has read-only repository Administration access; a missing, denied,
or malformed fallback remains a fail-closed result. A ruleset-managed branch
does not use that secret. For a manual check,
capture either the live active-rules response for `main` or the classic branch
protection API response and evaluate it with:

```sh
node scripts/evaluate-github-branch-protection.mjs \
  --input /absolute/path/to/main-protection.json \
  --repository OpenAEC-Foundation/open-pdf-studio \
  --output /absolute/path/to/repository-controls.json
```

Place the resulting `repository-controls.json` beside the other gate evidence
before running the final evaluator. Missing, incomplete, or stale evidence is a
fail-closed `MACOS OCR RELEASE HARDENING NO-GO`.

## Evidence contract

CI writes screenshots, traces, console logs, per-suite acceptance JSON, the
packaged adversarial OCR report, and performance JSON beneath the runner's
`test-artifacts` directory and uploads that directory even when a required job
fails. The final evaluator recursively reads those files and writes:

```text
open-pdf-studio/output/ocr-release-hardening/acceptance.json
```

The report includes the tested HEAD, packaged app identity, every audit finding
(`RB-01` through `RB-05`, `H-01` through `H-12`, `M-01` through `M-26`, `P1`
through `P9`, and `UX-01` through `UX-10`), measured performance thresholds,
commands, artifacts, required checks, and exactly one final decision. A finding
passes only when every suite mapped to it supplied passing evidence for the
same HEAD. A matching `gateId` alone is insufficient: each required report must
use its registered version 1 contract, and every non-repository report must
carry the exact evaluated HEAD.

The report also contains an `open-pdf-studio.authoritative-release-context`
record. `GO` requires GitHub's event name, base/head refs, merge ref, repository,
and event payload to agree on one open `pull_request` targeting `main`. Missing
payload evidence, push events, a non-`main` base, a closed pull request, or any
cross-field mismatch fail closed. The event payload is summarized rather than
copied into the durable report.

For a local evidence inspection, use the explicit diagnostic mode:

```sh
node scripts/evaluate-ocr-release-hardening.mjs \
  --local-diagnostic \
  --evidence-dir /absolute/path/to/test-artifacts \
  --expected-head "$(git rev-parse HEAD)" \
  --expected-repository owner/repository \
  --required-job-result static-verification=skipped \
  --required-job-result build=skipped \
  --required-job-result packaged-macos-editor-acceptance=skipped \
  --required-job-result save-render-coherence-report-verification=skipped \
  --required-job-result macos-editor-ocr-performance=skipped
```

Diagnostic mode deliberately writes a complete `NO-GO` report and exits
nonzero. Supplying command-line values that resemble a pull request is not a
local override: authoritative mode also requires a mutually consistent GitHub
pull-request event payload.

The macOS OCR hardening gate also requires the concrete artifact-hardening,
filesystem edge-case, packaged adversarial OCR, and `MACOS PRODUCTION GO` OCR
reports from the same HEAD. A generic passing job marker cannot replace any of
those supporting reports. Distribution-only artifact criteria remain separate
as described below. The existing filesystem contract keeps provider-dependent
`UNVERIFIED` evidence visible and advisory; an explicit filesystem `FAIL`
remains blocking.

The final uploaded decision artifact also contains the complete downloaded
evidence tree. Every path in `acceptance.json` is a portable relative path into
that uploaded tree, so the decision does not depend on ephemeral runner paths
or separately retained artifacts.

The packaged editor aggregate is intentionally fail-closed. It requires real
production-path acceptance for native source and owned text, inserted text,
textbox, callout, OCR one-line, OCR fixed multiline, and OCR reflow editors.
Browser-only component coverage cannot substitute for the inserted-text,
textbox, or callout packaged suite.

Its packaged coverage manifest contains exactly 384 view cases and 72
lifecycle cases: nine lifecycle scenarios for each of the eight editor
families. The lifecycle evidence includes a real pointer click on a visible
control outside the editor portal and properties-panel focus boundary. A valid
dirty draft must close, persist, and produce exactly one reversible document
undo unit without using Apply or Cancel. Apply and Command/Ctrl+Enter remain
explicit commit paths; Cancel and Escape remain discard paths.

The deterministic performance report uses the
`open-pdf-studio.editor-performance` version 1 contract and must contain all of
these measurements:

- typing-to-paint p95 below 16 ms;
- warm exact validation below 100 ms;
- maximum ordinary typing task below 50 ms;
- at most one active exact-layout task;
- zero idle placement reads and writes;
- history at or below 100 entries and 12 MiB;
- OCR UI publication at or below 10 Hz;
- OCR bookkeeping CPU below 1 percent on the 100-page fixture;
- monotonic OCR progress and no publication after cancellation.

## Signing boundary

The CI app is ad-hoc signed to prove bundle usability and hardened-runtime
compatibility. It is not evidence of Developer ID signing, Apple notarization,
stapling, Gatekeeper acceptance, or quarantine/download-style launch. Those
distribution claims remain exclusively in the credential-backed `release.yml`
and `nightly.yml` paths, where `--require-distribution-trust` makes every trust
criterion blocking.
