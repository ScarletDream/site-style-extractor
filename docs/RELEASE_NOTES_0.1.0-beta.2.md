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

The exact release commit, CI run, tarball checksum, and Docker result will be added when the candidate is finalized.
