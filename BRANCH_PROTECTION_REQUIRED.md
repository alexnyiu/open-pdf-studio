# Branch Protection Required

The authoritative release target is `OpenAEC-Foundation/open-pdf-studio` on
`main`. The implementing account currently has read-only access to that
repository, so F-21 remains blocked on a repository administrator.

Configure a branch ruleset or classic branch protection for `main` with all of
the following settings:

- Require pull requests before merging.
- Require at least one approving review.
- Require the branch to be up to date before merging.
- Prevent force pushes.
- Prevent branch deletion.
- Require exactly these status checks:
  - `Static verification`
  - `Desktop build (ubuntu-22.04)`
  - `Desktop build (windows-latest)`
  - `Desktop build (macos-26)`
  - `macOS packaged editor acceptance`
  - `save/render coherence report verification`
  - `macOS editor and OCR performance`
  - `macOS OCR release-hardening decision`

After an administrator applies the rule, rerun the protected pull-request
workflow. The `macOS OCR release-hardening decision` job must read the live
repository rules and report that the configured check set exactly matches this
list before F-21 can be closed.
