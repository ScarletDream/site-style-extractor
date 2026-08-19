---
name: stylejuicer
description: Use when a user provides a public website URL and asks to extract, reverse-engineer, study, compare, or document its UI style, design language, rendered typography, responsive layout, interaction states, or publicly delivered frontend mechanisms.
---

# StyleJuicer

Turn one public URL into an evidence-backed, portable design-language package. Extract the reference; do not implement the user's product.

## Boundary

- Use only public, unauthenticated, client-delivered evidence. Never sign in, submit, purchase, publish, upload, delete, or reuse a personal browser profile.
- Do not claim server source, private design files, hidden rationale, exhaustive coverage, or untested states.
- Do not copy brand marks, copy, illustrations, screenshots, proprietary assets, bundles, or a distinctive composition wholesale.
- Keep downstream implementation and repository rules outside this Skill.

The workflow separates mechanical and semantic responsibility:

1. **Scan** — a mechanical collector traverses one bounded desktop and narrow-viewport path, saves immutable candidate frames, rendered measurements, public resources, status, and failures, then builds internal contact sheets.
2. **Select** — the host Agent judges the contact sheets and chooses two to six candidate IDs that cover distinct visual systems. This is semantic evidence selection, not a hard-coded midpoint rule.
3. **Finalize and synthesize** — a deterministic finalizer promotes the exact selected staged bytes; the host Agent then turns that evidence and public mechanism clues into a portable profile.
4. **Validate** — deterministic scripts verify files, hashes, statuses, references, and YAML/Markdown agreement. They do not certify aesthetic truth.

## Capture one coherent surface

`surface` is the default mode. Treat the exact opened URL as the reference, not as an invitation to crawl the whole site.

Make five grouped decisions:

1. **Scope:** isolate the browser, normalize redirects, and record the surface. If the user explicitly requests a multi-page system audit, coordinate separate captures and keep divergent visual systems separate; the collector itself captures one URL.
2. **Main path:** capture desktop `1440×900` and a narrow viewport `390×844`; traverse incrementally. Follow one main path that may mix scrolling with one safe in-page reveal.
3. **Representative state:** sample one representative from repeated tabs/cards/slides rather than enumerating them. Attempt at most one representative reversible interaction: a non-navigating tab or `aria-expanded` control. Never click a form control, navigation link, dangerous action, or generic CTA for evidence. Verify restoration structurally; if it fails, record `click-unrestored` and reload once.
4. **Branch judgment:** follow a branch only when it is prominent, belongs to the same visual language, and adds a distinct rule. Ask the user only when two equally prominent branches would materially change the profile. Otherwise record skipped branches/outliers and continue.
5. **Uncertainty:** mark blocked, cross-origin, login-gated, time-dependent, inaccessible, or untested material `U`. A failed fresh capture remains a failure report; archived evidence is usable only with explicit date and provenance.

Prefer an available isolated browser tool. The default reproducible path is:

```powershell
stylejuicer doctor
stylejuicer scan https://example.com --run work/example-scan
# View the internal contact sheets, then write selection.json using candidate IDs only.
# If selection.json chooses one discovered interactionCandidateId:
stylejuicer interact https://example.com --run work/example-scan --selection work/example-scan/selection.json
stylejuicer finalize --run work/example-scan --selection work/example-scan/selection.json --out output/example-style
stylejuicer validate capture output/example-style
```

Candidates, probes, and contact sheets are internal audit material, not user-facing previews and not delivery evidence. Probes are derived from the already captured frame rather than recaptured from the live page. Finalization verifies the scan ID, URL fingerprint, manifest, contact-sheet and frame hashes, the six-image budget, viewport coverage, and real filesystem containment. It copies the exact selected staged bytes and never silently substitutes a nearby frame. Use only the unified `stylejuicer` CLI; the legacy `site-style` command is a temporary compatibility alias, and `src/` modules are internal engine APIs rather than parallel command-line entry points.

The scan may discover bounded safe tab or `aria-expanded` candidates but does not click them. It skips portal-style triggers whose controlled target does not exist at scan time. The Agent may select at most one `interactionCandidateId`; this reserves two of the six screenshot slots. `stylejuicer interact` then reopens the same URL in an isolated browser context, verifies a unique target fingerprint plus page identity and geometry, captures before/after, and checks structural restoration. During replay it blocks non-`GET`/`HEAD` requests, popups, and post-load navigation. A missing, ambiguous, changed, no-op, or unrestorable target remains partial/blocked and is never promoted as successful interaction evidence.

Interaction safety is best-effort, not a browser sandbox: a badly designed `GET` request can still mutate server state. Run only on public unauthenticated pages in a fresh isolated profile; never use this workflow with a signed-in or personal browser context.

CLI exit codes are `0` for a complete artifact, `1` for an unhandled execution error, `2` for invalid CLI usage, and `3` when a truthful `partial` or `blocked` artifact was written. Scan directories are retained for re-selection and audit; delete or archive them only after the final package passes validation.

Each scan has one 240-second in-process deadline in addition to the per-stage bounds. For a known slow public page, the Agent may explicitly pass `--timeout-ms` from 1000 to 900000; do not auto-extend a deadline after expiry. A deadline produces an atomic `blocked` artifact with the active stage and cannot be finalized. This closes Playwright best-effort but is not an operating-system resource sandbox.

The collector requires Node.js 20+ plus Playwright. It blocks loopback, link-local, private, and many non-global destinations as best-effort risk reduction; this is not a complete network sandbox. `allowPrivateNetwork: true` is for controlled fixtures only.

Readiness is bounded:

- Wait for fonts, non-zero layout, loader disappearance, and stable geometry samples.
- Incrementally traverse at most 16 positions per viewport and settle after scroll or safe interaction.
- Sparse content, low opacity/contrast, missing media, or continuous motion are review signals, not automatic rejection.
- A viewport-blocking loader, zero layout, or sparse graphical shell with insufficient style evidence produces `partial`; retained screenshots are diagnostic and cannot support style claims. A small inline or offscreen loader marker does not block substantive visible content.
- Bound DOM, CSS, and state samples. Record unresolved Canvas, video, or infinite motion instead of waiting forever.
- Scan at most 16 candidate positions per viewport. Candidate count is an internal indexing cost, not a user screenshot gallery.
- Select two to six final evidence screenshots globally. Include the opening and lower-page coverage of each complete viewport, then spend remaining slots on distinct visual systems rather than redundant responsive duplicates.
- A finalized package contains at most six selected screenshots total. Diagnostic frames are not successful evidence, but if deliberately included they still occupy a package slot.

## Synthesize from evidence

Read [analysis-rubric.md](references/analysis-rubric.md), then [output-contract.md](references/output-contract.md).

1. Judge composition, focal order, and visual hierarchy from screenshots before reading statistics.
2. Use `evidenceSummary` to challenge that judgment; inspect raw rendered records only for named claims.
3. Use the resource inventory and, when separately inspectable, public browser-delivered CSS/JavaScript only as public mechanism clues. Map visible effect → selector/target → decisive declaration or resource → confidence. Do not imply that the collector automatically reverse-engineered code.
4. Separate tokens, composition/component grammar, and taste decisions. Do not promote a one-off decorative value into a system rule.
5. Produce three to five source-specific decisions. Each needs a visible trigger, observed choice, plausible unchosen alternative, trade-off, concrete evidence, and `O/R/I/U` confidence. If it could describe an unrelated modern site unchanged, rewrite or remove it.

Confidence labels:

- `O` — directly observed at a named viewport/state.
- `R` — repeated in captured sections/states.
- `I` — inference from observed evidence.
- `U` — unknown or untested.

Write portable guidance as: `Use [specific mechanism] for [effect]; avoid [failure mode].` Never state inferred design rationale as fact.

## Deliver and validate

Create exactly the five artifacts defined by the output contract:

- `screenshots/`
- `evidence.json`
- `public-code-map.json`
- `style-profile.yaml`
- `analysis.md`

`style-profile.yaml` is the interpretation-layer machine source of truth. Generate the decision table in `analysis.md` rather than maintaining a second handwritten copy:

```powershell
stylejuicer render --profile output/example-style/style-profile.yaml --analysis output/example-style/analysis.md
stylejuicer validate delivery output/example-style
```

Validation proves structural consistency only. Before delivery, also perform a semantic review: screenshots support the verdict; source-specific decisions pass the swap test; public mechanisms are not overstated; unknown motion, accessibility, authenticated, or destructive states remain unknown; and nothing proprietary was copied.

Keep screenshots as evidence rather than a gallery. In the response, show at most three representative previews unless the user asks for more, state the total count and capture status, and link the package.

## Common failures

| Failure | Correction |
|---|---|
| “Clean”, “premium”, or other generic adjectives | Name measured hierarchy, geometry, contrast, or a trade-off. |
| Fixed midpoint treated as representative | Scan the bounded path and select candidate IDs that cover each distinct visual system. |
| One desktop frame treated as a design system | Add the narrow viewport and lower-page/state evidence or mark it blocked. |
| Every tab, slide, or branch captured | Keep one main path and one representative state. |
| Loading shell presented as the target style | Keep it diagnostic and report partial/blocked. |
| Resource inventory described as source-code understanding | Call it public mechanism clues and identify what was actually inspected. |
| Exact imitation handed to implementation | Transfer mechanisms and constraints; exclude identity assets and unique composition. |
