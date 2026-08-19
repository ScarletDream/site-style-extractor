# Output contract

This file is the normative artifact and decision schema. `style-profile.yaml` is the interpretation-layer machine source of truth; `analysis.md` contains a generated view of its source-specific decisions, not a separately authored copy.

Create one output directory per extraction.

```text
site-style-output/
├── screenshots/
├── evidence.json
├── public-code-map.json
├── style-profile.yaml
└── analysis.md
```

The preferred capture path first creates a separate internal scan directory containing staged frames, frame-derived probes, hash-bound contact sheets, `scan-evidence.json`, `scan-manifest.json`, and `selection.json`. These files are provenance and Agent-selection aids; they are not a sixth delivery artifact and should not be shown to the user unless requested. `stylejuicer finalize` promotes two to six exact staged frame bytes into a new or empty five-artifact directory after verifying IDs, hashes, coverage, budget, and filesystem containment. It builds transactionally and refuses a non-empty output directory.

## evidence.json

Include:

- `schemaVersion: "2.0.0"`, scrubbed requested/final URL identities, capture timestamp, and capture status.
- Inspected pages, viewports, scroll positions, and interaction states.
- `mainPath`: the ordered scroll and click trace followed through the referenced surface.
- `representativeStates`: states selected because they demonstrate distinct visual or motion grammar.
- `skippedBranches`: visible branches not followed, with the model's reason.
- `outliers`: reached or visible surfaces that use a divergent design language and were excluded from the main profile.
- Screenshot paths and hashes.
- `scanProvenance` when staged selection was used: scan ID, manifest hash, budget-policy version, chosen candidate IDs, and optional selection rationale.
- `captureStatus`, bounded readiness attempts, soft review signals, incremental traversal positions, and unresolved motion.
- `evidenceSummary`: representative elements, typography, colors, layout, and motion. Keep raw element evidence available for targeted lookup.
- DOM/CSS sampling limits and truncation flags. A truncated raw inventory is acceptable when the compact summary and named evidence remain sufficient; never imply exhaustive source inspection.
- Rendered element samples, geometry, computed styles, CSS variables, media queries, fonts, animations, and media counts.
- Bounded `publicMechanismCandidates` that connect an observed target selector to a matched public CSS selector, decisive declarations, and scrubbed stylesheet identity. These are clues, not reconstructed source ownership or rationale.
- Bounded, scrubbed console/runtime failures and inaccessible surfaces.

Do not place analysis conclusions in raw evidence fields.

`captureStatus.status` is `complete`, `partial`, or `blocked`. Sparse content, low contrast, low opacity, and ongoing motion are soft signals only. A persistent explicit loader or zero body layout may produce `partial`; keep its screenshot as `kind: diagnostic` and do not cite it as successful style evidence.

## public-code-map.json

Use this minimum shape. Resource references use the stable `resourceId` from `evidence.json`; persisted URLs are scrubbed identities and never contain query values.

```json
{
  "mechanisms": [{
    "visibleEffect": "",
    "selector": "",
    "keyDeclarationOrResource": "",
    "evidenceRefs": [
      {"kind": "screenshot", "id": "screenshots/desktop.png"},
      {"kind": "selector", "id": ".hero", "viewport": "desktop"},
      {"kind": "resource", "id": "res_example"}
    ],
    "confidence": "O"
  }],
  "frameworkHints": [{"name": "", "evidence": "", "confidence": "I"}],
  "limits": []
}
```

A mechanism is a visible-effect mapping, not a resource count. Do not duplicate the resource inventory here; reference stable IDs from `evidence.json`. Name what changed on screen, the selector or rendered target, the decisive public CSS declaration or resource, structured `evidenceRefs`, and confidence. If any link in that chain is unobserved, mark it `I` or `U` rather than filling it by analogy.

Do not embed minified source, source maps, proprietary images, or copied component code.

## style-profile.yaml

Use `schemaVersion: "2.0.0"`. The following `sourceSpecificDecisions` record is normative; do not duplicate its schema in another reference:

```yaml
sourceSpecificDecisions:
  - visibleTrigger: ""
    choice: ""
    plausibleUnchosenAlternative: ""
    tradeOff: ""
    evidenceRefs:
      - {kind: screenshot, id: "screenshots/example.png"}
      - {kind: selector, id: ".hero", viewport: desktop}
      - {kind: resource, id: "res_example"}
    confidence: O # O, R, I, or U
```

Include:

- Source URLs, capture date, status, and tested viewports/states.
- Direction sentence and visual axes.
- Semantic color, type, spacing, radius, border, elevation, and motion roles.
- Layout and responsive grammar.
- Component anatomy and state grammar.
- One signature mechanism with evidence.
- Portable rules, prohibited copying, and unknowns.
- `sourceSpecificDecisions`: three to five records using the normative schema above. Each adopted decision needs at least one structured reference. Diagnostic screenshots may be mentioned only as limitations, never used in adopted decision or mechanism references.
- `value`, `confidence`, and `evidence` for every nontrivial token or rule.

## analysis.md

Use this order:

1. Scope and evidence freshness.
2. One-sentence design-language verdict.
3. Composition and responsive behavior.
4. Typography.
5. Color and surface.
6. Components and states.
7. Interaction and motion.
8. Public implementation mechanisms.
9. What to borrow and what not to copy.
10. Unknowns and failed checks.

Include the generated source-specific decision table between these exact markers:

```markdown
<!-- BEGIN GENERATED SOURCE-SPECIFIC DECISIONS -->
<!-- END GENERATED SOURCE-SPECIFIC DECISIONS -->
```

Create or refresh it with:

```powershell
stylejuicer render --profile style-profile.yaml --analysis analysis.md
```

Do not hand-edit the generated block. Narrative sections remain human/Agent-authored.

Keep it concise enough for another Agent to load without discarding the underlying evidence files.

## Validation

Run the structural gates from the Skill root:

```powershell
stylejuicer validate capture path/to/package
stylejuicer validate delivery path/to/package
```

The capture gate checks schema/status consistency, screenshot existence, and hashes. The delivery gate additionally checks all five artifacts, YAML parsing, decision shape, screenshot/resource references, diagnostic citation, and the generated Markdown block. These gates do not judge whether the style analysis is perceptive or useful; that remains semantic review.

For a staged scan, selection must reference candidate IDs only—never arbitrary paths, selectors, or scroll coordinates. A changed or missing frame fails finalization. A partial candidate remains diagnostic and cannot be promoted into successful style evidence.

An optional staged interaction is also ID-bound. The scan only discovers candidates whose controlled target already exists; selection may choose one `interactionCandidateId`, leaving at most four static candidate IDs. A separate isolated capture verifies page identity and geometry, a unique target fingerprint, meaningful before/after change, restoration, hashes, and result provenance. It blocks non-`GET`/`HEAD` requests, popups, and post-load navigation. Finalization promotes the pair only when that result is complete, changed, and reversible; total screenshots remain at most six. This remains best-effort protection because a public `GET` endpoint can be implemented with side effects; never replay interactions in an authenticated or personal browser context.

## User-facing presentation

Keep all necessary screenshots in the evidence package, but embed at most three representative previews in the response unless the user asks to inspect more. State the total screenshot count and link the output directory. Do not make the user scroll through an evidence gallery to understand the result.
