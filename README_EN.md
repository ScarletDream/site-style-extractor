# Site Style Extractor

[简体中文](README.md) | **English**

Give an Agent one public website URL and get an evidence-backed, portable UI design-language package rather than a pile of generic adjectives.

The project combines three boundaries:

1. A deterministic Playwright collector scans one desktop and narrow path, saves immutable candidate frames, rendered measurements, public resources, and honest failures.
2. An Agent selects representative evidence and synthesizes transferable visual rules and trade-offs.
3. Deterministic finalization and validation verify hashes, statuses, references, and the five-artifact contract.

It extracts style. It does not implement the user's product or copy the source site's brand assets and distinctive composition.

## Requirements

- Node.js 20 or newer.
- npm.
- The Chromium revision paired with Playwright 1.62.1.

```bash
npm install
node node_modules/playwright/cli.js install chromium
node bin/site-style.cjs doctor --json
```

On machines with multiple Node versions, invoke the supported Node executable explicitly. `doctor` reports the selected Node, Playwright, Chromium, OS, architecture, headless mode, and output writeability.

## CLI

```bash
site-style doctor
site-style scan https://example.com --run work/example-scan
site-style interact https://example.com --run work/example-scan --selection work/example-scan/selection.json
site-style finalize --run work/example-scan --selection work/example-scan/selection.json --out output/example-style
site-style render --profile output/example-style/style-profile.yaml --analysis output/example-style/analysis.md
site-style validate delivery output/example-style
```

Every command supports `--json`. Machine results go to stdout and diagnostics go to stderr.

| Exit | Meaning |
|---:|---|
| 0 | Complete success |
| 1 | Execution or validation failure |
| 2 | Invalid command usage |
| 3 | A valid `partial` or `blocked` artifact was honestly produced or validated |

`interact` is explicit because it reopens a website. `finalize` never hides an online click inside an apparently offline command.

## Output

A complete delivery contains:

- `screenshots/`
- `evidence.json`
- `public-code-map.json`
- `style-profile.yaml`
- `analysis.md`

Internal candidates, probes, and contact sheets remain audit material. The final package contains at most six selected screenshots.

## What `partial` and `blocked` mean

`partial` is a usable but incomplete result, such as one viewport succeeding while another remains behind a loader. `blocked` means the requested evidence could not be safely obtained. They are valid recorded outcomes, not successful style extraction, and return exit code 3.

The collector never treats a loader, browser error page, blank canvas, or low-information transition as proof of the intended design. `sparse-graphical-shell` means that the current frame is insufficient evidence; it does not assert that every text-free minimalist splash is a loader. DOM/CSS clues from a failed visual capture remain explicitly inferred.

Traversal, DOM/CSS sampling, settling, screenshots, diagnostics, and interaction targets are individually bounded. The beta does not yet enforce a hard operating-system wall-clock, memory, or network-byte ceiling for the entire browser process. For untrusted public pages, run it in a disposable environment with an external timeout and resource limits; a partial result is preferable to relaxing those limits.

## Rendering limits

This tool does not promise pixel-equivalent reproduction. WebGL, Canvas, video, system fonts, codecs, GPU drivers, headless rendering, continuous animation, A/B tests, and geographically delivered content can differ between runs and machines. Docker improves dependency consistency; it does not make these surfaces identical to the user's desktop.

## Codex Plugin

The repository contains a Plugin Skill under `skills/site-style-extractor`. The Skill provides Agent orchestration and analysis rules; the npm CLI provides deterministic execution. Plugin installation does not necessarily install npm or Chromium automatically, so run `site-style doctor` before capture.

The Plugin is the reasoning/orchestration layer, not a second copy of the browser engine. Install the npm package (or use this repository checkout) and its pinned Chromium separately. Until the package is published to a registry, run the CLI as `node bin/site-style.cjs ...` from this checkout.

## Docker

The Docker image exposes the same CLI and pins the matching Playwright image. It is experimental until the repository's Linux Docker build-and-doctor CI has passed on the published commit:

```bash
docker build -t site-style-extractor:0.1.0-beta.1 .
docker run --rm site-style-extractor:0.1.0-beta.1 doctor --json
docker run --rm --init --memory=2g --cpus=2 -v "$PWD/work:/work" site-style-extractor:0.1.0-beta.1 \
  scan https://example.com --run /work/example-scan --json
```

The container runs as the non-root `pwuser`. Mount only a dedicated output directory; do not mount a personal browser profile, cookie store, or credentials. Docker standardizes the browser dependency but is not a network sandbox and does not guarantee desktop-identical WebGL, Canvas, video, fonts, or animation.

On Linux, make the mounted output directory writable by the container user before capture. Prefer a disposable directory rather than weakening permissions on an existing project tree.

## Development

```bash
npm test
npm pack --dry-run
```

Public regression tests use local synthetic fixtures. Real websites are non-blocking smoke tests because CDN failures, rate limits, and live redesigns are external state.

Before contributing or publishing a release, read [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## License

MIT. The license covers this project's code and documentation, not third-party
websites, screenshots, fonts, brands, or assets observed by a user-run capture.
See [LICENSE](LICENSE) for the controlling text and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for direct runtime dependencies.
