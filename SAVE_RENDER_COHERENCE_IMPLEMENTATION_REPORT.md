# Save/Render Coherence Implementation Report

## Baseline and final commits

- Baseline: `d105926ed7760fa274308dc83f9a6609b49c9bfd`
- Baseline title: `Improve text-edit auto-save persistence and diagnostics`
- Final: Pending
- Branch: `ocr-release-hardening`
- Platform: macOS Darwin 25.6.0 arm64
- Node: v25.6.1
- npm: 11.9.0
- Rust: rustc 1.97.1, cargo 1.97.1
- Tauri CLI dependency: `^2.10.0`

## Root cause resolved

Pending implementation. Baseline reproduction confirms that automatic persistence can leave the live PDF revision unrepresented, after which ordinary dirty checks allow same-path Save to return a false no-op.

## Architecture implemented

- revision state: Pending
- save coordinator: Pending
- proxy synchronization: Pending
- publication tokens: Pending
- edit readiness: Pending
- cache invalidation: Pending
- UI recovery: Pending

## Finding disposition

| Finding | Status | Commit | Files | Tests/evidence |
|---|---|---|---|---|
| F-01 | Reproduced | Pending | `open-pdf-studio/js/pdf/save-state.test.mjs` | Deterministic false no-op regression fails at baseline |
| F-02 | Pending | Pending | Pending | Pending |
| F-03 | Pending | Pending | Pending | Pending |
| F-04 | Pending | Pending | Pending | Pending |
| F-05 | Pending | Pending | Pending | Pending |
| F-06 | Pending | Pending | Pending | Pending |
| F-07 | Pending | Pending | Pending | Pending |
| F-08 | Pending | Pending | Pending | Pending |
| F-09 | Pending | Pending | Pending | Pending |
| F-10 | Pending | Pending | Pending | Pending |
| F-11 | Pending | Pending | Pending | Pending |
| F-12 | Pending | Pending | Pending | Pending |
| F-13 | Pending | Pending | Pending | Pending |
| F-14 | Pending | Pending | Pending | Pending |
| F-15 | Pending | Pending | Pending | Pending |
| F-16 | Pending | Pending | Pending | Pending |
| F-17 | Pending | Pending | Pending | Pending |
| F-18 | Pending | Pending | Pending | Pending |
| F-19 | Pending | Pending | Pending | Pending |
| F-20 | Reproduced | Pending | CI run 33148195868 | Static verification fails 19 OCR tests because untracked generated PNG fixtures are absent in a clean checkout |
| F-21 | Pending | Pending | Pending | Pending |
| F-22 | Reproduced | Pending | `open-pdf-studio/scripts/test-save-continue-editing-macos.mjs` | Explicitly red packaged scenario outline |
| F-23 | Blocked | N/A | GitHub repository settings | `gh issue create` returned: `the 'alexnyiu/open-pdf-studio' repository has disabled issues` |

## Test commands and results

### Phase 0 baseline

| Command | Result |
|---|---|
| `npm ci` | Environment failure: root-owned `~/.npm` cache returned `EPERM` |
| `NPM_CONFIG_CACHE=/tmp/open-pdf-studio-save-coherence-npm-cache npm ci` | PASS; locked dependency install completed |
| `npm run typecheck` | PASS |
| `npm run test` | PASS locally with generated fixture PNGs present |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `cargo test -p open-pdf-studio` | PASS: 75 unit tests plus focused integration tests; one pool-parity test ignored by existing configuration |
| `cargo test -p pdfium-worker` | PASS: 15 passed, 2 ignored by existing configuration |
| `node --test js/pdf/save-state.test.mjs` after red test | EXPECTED FAIL: F-01 returned `true` instead of `false` for disk-clean synchronization debt |
| `node scripts/test-save-continue-editing-macos.mjs` | EXPECTED FAIL: authoritative packaged scenario not implemented yet |

### Baseline CI classification

- GitHub Actions run: https://github.com/alexnyiu/open-pdf-studio/actions/runs/33148195868
- Category: existing branch regression in clean-checkout fixture provisioning.
- Failure: 19 OCR tests fail after missing generated PNG fixtures produce `ENOENT`; the first missing file is `open-pdf-studio/tests/fixtures/ocr/quality-v1/punctuation-unicode.png`.
- Consequence: frontend build, whitespace, Rust, desktop build, packaged editor acceptance, and performance jobs are skipped.
- Local/CI difference: the PNG files exist locally but `git ls-files` contains only the fixture Markdown and JSON files.

## Packaged acceptance

- app artifact: Pending
- report artifact: Pending
- scenarios passed: Pending
- stale publication count: Pending

## Performance comparison

Pending Phase 10 measurements.

## CI and protection evidence

- workflow run: Baseline failure recorded above
- required checks: Pending
- admin blockers: GitHub Issues are disabled, preventing the required parent and linked workstream issues. Repository-rule administration remains to be verified in Phase 11.

## Remaining risks

- All runtime findings remain open after Phase 0.
- The source audit named by the supplied plan, `open-pdf-studio-ocr-release-hardening-bug-audit.md`, was not present in the workspace, Downloads, or Documents search scope.
