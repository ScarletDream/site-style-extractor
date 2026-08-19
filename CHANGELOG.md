# Changelog

All notable user-visible changes will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.2] - 2026-08-20

### Added

- Public-release governance, contribution, security, and issue templates.
- One scan-wide 240-second in-process deadline with an explicit 1-second to
  15-minute CLI override, bounded Playwright cleanup, terminal artifact
  protection, and runtime-budget provenance.

### Changed

- Rename the product, npm package, Codex Plugin, and Skill to StyleJuicer;
  expose `stylejuicer` as the primary CLI while retaining `site-style` as a
  temporary Beta compatibility alias.
- Use MIT as the project license and make the complete Chinese README the
  default GitHub landing page, with a complete English counterpart.
- Refine readiness around viewport-blocking loaders, sparse graphical shells,
  and inline or offscreen loader markers.
- Add cross-scroll visual-progress checks, concrete status reasons, and truthful
  CLI propagation for persisted failures.

## [0.1.0-beta.1] - 2026-08-18

### Added

- Bounded Playwright scan, representative interaction replay, deterministic
  finalization, rendering, validation, and runtime diagnosis commands.
- Evidence package contract with screenshots, rendered evidence, public-code map,
  portable style profile, and analysis.
- Honest `complete`, `partial`, and `blocked` states with stable CLI exit codes.
- Skills-only Codex Plugin wrapper, synthetic regression fixture, CI, and an
  experimental pinned Playwright Docker image.

[Unreleased]: https://github.com/ScarletDream/stylejuicer/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/ScarletDream/stylejuicer/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/ScarletDream/stylejuicer/releases/tag/v0.1.0-beta.1
