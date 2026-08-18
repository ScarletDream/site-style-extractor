# Contributing

Site Style Extractor separates deterministic browser evidence from Agent judgment.
Changes should preserve that boundary: collectors record bounded facts and honest
failure states; the Skill selects evidence and explains portable design rules.

## Development setup

Requirements: Node.js 20 or newer, npm, and the Chromium revision paired with the
pinned Playwright version.

```bash
npm ci
node node_modules/playwright/cli.js install chromium
node bin/site-style.cjs doctor --json
npm test
```

## Pull requests

- Keep the public command surface in `bin/site-style.cjs`; do not add parallel
  hidden CLIs under `src/`.
- Add a regression test before changing capture, network, state, hashing, or
  validation behavior.
- Preserve exit semantics: `0` complete, `1` execution/validation failure, `2`
  usage error, and `3` honest `partial`/`blocked` output.
- Use synthetic or self-owned fixtures in committed tests. Do not commit captures,
  screenshots, fonts, brands, cookies, tokens, or private-page content from third
  parties.
- Treat external websites as non-blocking smoke tests, not stable assertions.
- Update `CHANGELOG.md` for user-visible behavior.

## Reporting security issues

Follow `SECURITY.md`. Do not put working exploits or sensitive captures in public
issues.
