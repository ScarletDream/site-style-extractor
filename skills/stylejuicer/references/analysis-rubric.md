# Analysis rubric

Use this inventory to analyze collected evidence. Cite the page, viewport, state, selector, screenshot, or resource for every material conclusion.

## Evidence order

1. Read the screenshots first and write a provisional focal-order and composition account.
2. Read the compact `evidenceSummary` to confirm or challenge the visual account.
3. Query raw elements, styles, and resources only for claims that need exact support.

Large DOM inventories are lookup material, not the narrative. A measurement that is visually irrelevant does not become a design rule merely because it is frequent.

## Product surface

- Classify marketing, consumption, creation, administration, commerce, or play.
- Record the primary visible job and focal order without inferring hidden product intent.
- Treat the user's entry surface and its main scroll/click narrative as primary evidence.
- Keep divergent product apps, documentation, blogs, and legacy interfaces out of the main profile unless explicitly requested.
- Promote a sibling interaction to evidence only when it adds a distinct visual or motion rule; otherwise sample one representative state.

## Composition

- Measure viewport, content rails, max width, columns, fixed/sticky regions, overflow, section heights, and whitespace rhythm.
- Separate shared grid structure from decorative cards.
- Compare desktop and narrow viewport recomposition; do not call an emulated width a real-device or universal responsive result.

## Typography

- Separate display, body, utility, data, and code roles.
- Record family stack, actual sampled font when available, size, line height, weight, tracking, casing, and text measure.
- Mark font substitutions and CJK fallback behavior as inferred unless directly sampled.

## Color and surface

- Extract semantic roles: canvas, surface, raised surface, primary/muted text, border, accent, success, warning, and danger.
- Record area and repetition before promoting a color to a system token.
- Identify elevation by border, tonal shift, overlap, shadow, blur, or glow.

## Components and states

- Record anatomy, geometry, internal spacing, hierarchy, and repeated variants.
- Compare default, hover, focus, selected, expanded, disabled, loading, empty, success, error, and destructive states only when reached safely.

## Interaction and motion

- Record trigger, property change, duration, delay, easing, sequencing, and reduced-motion behavior.
- Distinguish CSS transition/keyframes, Web Animations, Canvas, WebGL, and video.
- Do not infer timing from a static screenshot.

## Public mechanism clues

- Inventory stylesheets, scripts, fonts, images, SVG, Canvas, WebGL, video, and iframes.
- Use framework hints as hints, not proof.
- When a public CSS/JavaScript resource is separately inspectable, use it to explain a named visible mechanism. A resource inventory alone is not code understanding. Store the scrubbed identity, observation, and confidence rather than copying code.
- Prefer bounded `publicMechanismCandidates` when present: they mechanically connect a rendered target to a matched browser-delivered CSS rule. Recheck the named screenshot and computed state; a matched rule does not prove an unobserved hover, pseudo-element, animation phase, or design rationale.

## Taste decision test

Keep a taste decision only when all four are present:

1. A repeated or dominant trigger.
2. The observed decision.
3. A plausible alternative the design did not choose.
4. A concrete trade-off supported by evidence.

Reject any principle that could have been written without seeing this particular site.

Keep three to five source-specific decisions using the single normative schema in [output-contract.md](output-contract.md).

Apply a semantic swap test: if the record survives unchanged after replacing the source with an unrelated site, it is generic and must be rewritten or removed.
