# Release checklist

## Repository identity

- [x] Choose the final owner/name and prepare the public repository metadata.
- [x] Add release links in `CHANGELOG.md`.
- [x] Add `repository`, `homepage`, and `bugs` URLs to `package.json`.
- [x] Enable GitHub Private Vulnerability Reporting and verify `SECURITY.md`.

## Cold installation

- [x] Restart Codex, open a new conversation, and verify that
  `stylejuicer` is discovered from the Plugin rather than a legacy user
  Skill path. Verified from a fresh task on 2026-08-20 without visiting a website.
- [x] In a disposable consumer project, install the real npm tarball and its
  paired Chromium, then run the installed `stylejuicer doctor --json`.
- [x] Run the packaged synthetic fixture through scan, finalize, render, and both
  validators without resolving dependencies from the source checkout. Reproduce
  with `npm run release:smoke`.

## Verification

- [x] Run `npm ci`, `npm test`, and `npm pack --dry-run --json` from a clean tree.
- [x] Push the candidate commit and require all Node 20/22 OS matrix jobs to pass.
- [x] Require the Linux Docker build, packaged-install smoke, and `doctor` jobs to
  pass on the exact candidate commit.
- [x] Inspect the tarball: no tests, captures, credentials, private evidence,
  `node_modules`, or third-party screenshots.
- [x] Validate the Skill and Plugin manifests with the current official validators.

## Publication

- [x] Maintainer explicitly confirms the license after reviewing
  `docs/LICENSE_DECISION.md`; do not infer consent from the provisional file.
- [x] Review MIT and all direct/transitive dependency licenses; the installed
  runtime graph is summarized in `THIRD_PARTY_NOTICES.md`.
- [x] Tag the exact tested commit as `v0.1.0-beta.2`.
- [x] Prepare release notes from `CHANGELOG.md` in
  `docs/RELEASE_NOTES_0.1.0-beta.2.md`; do not publish them before the release.
- [x] If publishing npm, verify account, package-name availability, provenance, and
  a clean temporary-directory install before announcing it.
- [ ] Treat universal Plugin directory submission as a separate release channel;
  local marketplace discovery does not prove public directory installation.

No checklist item may be marked complete from an earlier commit's evidence.
