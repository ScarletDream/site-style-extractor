# Release checklist

## Repository identity

- [x] Choose the final owner/name and prepare the public repository metadata.
- [x] Add release links in `CHANGELOG.md`.
- [x] Add `repository`, `homepage`, and `bugs` URLs to `package.json`.
- [ ] Enable GitHub Private Vulnerability Reporting and verify `SECURITY.md`.

## Cold installation

- [ ] Restart Codex, open a new conversation, and verify that
  `site-style-extractor` is discovered from the Plugin rather than a legacy user
  Skill path.
- [ ] On a clean machine or disposable user profile, install dependencies and the
  paired Chromium, then run `site-style doctor --json`.
- [ ] Run one complete synthetic capture through scan, finalize, render, and both
  validators without relying on the source checkout's `node_modules`.

## Verification

- [ ] Run `npm ci`, `npm test`, and `npm pack --dry-run --json` from a clean tree.
- [ ] Push the candidate commit and require all Node 20/22 OS matrix jobs to pass.
- [ ] Require the Linux Docker build and `doctor` smoke job to pass before removing
  the Docker experimental label.
- [ ] Inspect the tarball: no tests, captures, credentials, private evidence,
  `node_modules`, or third-party screenshots.
- [ ] Validate the Skill and Plugin manifests with the current official validators.

## Publication

- [x] Maintainer explicitly confirms the license after reviewing
  `docs/LICENSE_DECISION.md`; do not infer consent from the provisional file.
- [ ] Review MIT and all direct/transitive dependency licenses.
- [ ] Tag the exact tested commit as `v0.1.0-beta.1`.
- [ ] Create release notes from `CHANGELOG.md`.
- [ ] If publishing npm, verify account, package-name availability, provenance, and
  a clean temporary-directory install before announcing it.
- [ ] Treat universal Plugin directory submission as a separate release channel;
  local marketplace discovery does not prove public directory installation.

No checklist item may be marked complete from an earlier commit's evidence.
