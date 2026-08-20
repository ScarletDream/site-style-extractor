# StyleJuicer 0.1.0-beta.2

StyleJuicer turns one public website surface into a validated, portable UI style package. It combines bounded Playwright evidence collection, Agent judgment, deterministic finalization, and structural validation.

## Included in this Beta

- Desktop and narrow-viewport main-path scanning with immutable candidate frames and contact sheets.
- Agent selection of two to six representative screenshots by candidate ID.
- Optional, isolated replay of one reversible tab or `aria-expanded` interaction.
- Five-artifact output: screenshots, evidence, public mechanism clues, a machine-readable style profile, and human-readable analysis.
- Honest `complete`, `partial`, and `blocked` outcomes with stable exit codes.
- A 240-second default scan deadline, bounded cleanup, URL redaction, and best-effort public-network protections.
- Codex Personal Plugin packaging, npm CLI packaging, and a pinned Playwright Docker environment.

## What this Beta does not promise

- It is not a one-click website clone.
- It does not access authenticated pages, private source, design files, or hidden rationale.
- It does not guarantee every URL will load or that Canvas, WebGL, video, fonts, and continuous animation will render identically across machines.
- Deterministic validation proves package consistency, not taste; Agent judgment remains part of the workflow.

## Installation after publication

```bash
npm install -g stylejuicer@beta
npx --yes playwright@1.62.1 install chromium
stylejuicer doctor --json
```

The Codex Plugin and npm/Chromium runtime are separate installation layers.

## Verification summary

- 127 automated tests across the source candidate.
- A real npm tarball installed into a disposable consumer project, followed by packaged `doctor`, synthetic scan/finalize/render, and capture/delivery validation.
- Three medium-distance UI transfers scored 93, 96, and 92 under a precommitted rubric; see `docs/EVALUATION.md` for limitations.

Release evidence:

- Commit: `685adea6c65e4a6c9f7c6c907ecd7f746ac095e8`
- GitHub Actions: run `32323481775`, including the OS/Node matrix, package smoke, and Docker `doctor`
- npm: `stylejuicer@0.1.0-beta.2`, published publicly under the `beta` tag
- npm tarball SHA-1: `f49987518521c14401ea8ea66e9bfaec0d4731e1`
- Registry cold install: installed from `registry.npmjs.org`; packaged CLI `--help` and `doctor --json` passed with Playwright 1.62.1 and Chromium 151

The GitHub prerelease is intentionally separate from npm publication and has not yet been created.
