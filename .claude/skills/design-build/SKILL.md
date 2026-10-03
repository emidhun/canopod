---
name: design-build
description: Implement a screen from a Canopod design handoff — token-faithful, backend-honest, and verified by measurement rather than eye. Use when asked to build, port, or revamp a screen from a design file (Canopod Redesign.html, Canopod Modals.html, Canopod Settings.html, Canopod Onboarding.html) or any design-system handoff.
---

# Building a screen from the design handoff

This encodes what two shipped ports (#57 workspace, #61 dialogs) actually cost.
Every rule below exists because skipping it produced a defect that reached a
build. Read `verify.md` in this directory for the measurement recipes.

The single most important idea: **you cannot verify a design port by reading
stylesheets.** Every bug that survived an audit survived because the audit
compared CSS instead of the rendered result.

---

## Phase 0 — Read the design properly

1. **Locate the handoff.** Usually a zip the user extracts. Contains
   `tokens/`, `components/components.css`, one HTML per screen, `cx*.jsx`
   modules, `readme.md`, `github.md`.
2. **Read `readme.md` and `github.md` first.** The readme states load-bearing
   rules (the radius rule, colour meanings, elastic-vs-fixed, container
   queries) and `github.md` maps each screen to the source files it was drawn
   from. Both are authoritative context you cannot infer from CSS.
3. **Read the screen's JSX, not only its `<style>`.** The stylesheet tells you
   how things look; only the markup tells you **what exists**. A menu with the
   right CSS and three of its eight rows passes a stylesheet diff.
4. **Render it.** Serve the handoff directory and open the screen:

   ```
   cd <handoff>/project && python3 -m http.server 5310
   ```

   It is a live React app. Drive it, open its flows, and measure it. This is
   the reference for every later comparison.

---

## Phase 1 — Audit the backend before writing UI

**Never trust a claim about the backend — including your own, and including a
reviewer's. Verify against the source.** In #61 every one of four reviewer
claims about Rust behaviour was true and two were worse than described; a
regex was matched against a marker format that never existed.

For each capability the design implies, find the actual command in
`src-tauri/src/` and the typed wrapper in `src/ipc.ts`. Check:

- the **exact output format** you will parse (`setup.rs` emits
  `{label} [1/3]: cmd`, not `[1/3]: cmd`)
- **truncation** (`git::dirty_report` caps at `.take(10)` — a count of 10 is a
  floor, not a total)
- **validation ranges** (`set_service_port` rejects outside 1024–65535)
- **derivation rules** you intend to mirror (`sanitize_branch` preserves case
  and maps to `_`; the dir is `{repo.path}-worktrees`)

Classify every gap as **frontend-fixable** or **backend-missing**. Things that
look like backend gaps often are not: a discarded `exitCode`, missing stats
history, and unshared context state were all frontend fixes in #61.

---

## Phase 2 — Build

### Token discipline

- **Everything from the design system's vocabulary resolves from tokens**:
  spacing, type ramp, weights, radii, colours, shadows, chrome heights,
  surface widths.
- **Never round a literal onto a scale that cannot express it.** If the design
  uses 8px and the scale has 7 and 9, do not pick 7 — *count the usage*, and
  if it earns a place, extend the scale. In the Canopod handoff 8px was the
  most-used spacing value in the entire screen and was not on the scale.
  Rounding produced a dozen 1px drifts across two PRs.
- **Add tokens by role when the index scale can't be interleaved** — the
  component layer ships verbatim against `--sp-1…8`, so renumbering silently
  repoints it.
- **One-off element geometry stays literal**: a 7px dot, a 13px checkbox,
  table column tracks. A token per single call site obscures the scale.
- `@media` / `@container` conditions **cannot** use custom properties. That is
  a language limit, not a choice — say so rather than claiming full coverage.
- **Never claim "zero hardcoded values" without auditing.** State exactly what
  is tokenized and what is not.

### Resolving handoff contradictions

The handoff contradicts itself — repeatedly, and in ways only measurement
finds. Apply this rule and **record each instance in the PR**:

> A screen overriding a **generic primitive** for its own context **wins**.
> A screen contradicting a **specific token backed by documented rationale**
> **loses**.

Every instance found across the two ports, so the next one starts from the
record rather than rediscovering them:

| # | Conflict | Resolved |
|---|---|---|
| 1 | `.cx-search` input is `--fs-small`; the screen sets `--fs-body` | screen |
| 2 | screen `.topbar` 38px; `--h-topbar` 36px + readme "chrome totals 106px" | token |
| 3 | screen `.rail` 38px; `--h-rail` 34px + the same readme statement | token |
| 4 | `components.css` type is 9/10/11/12px — each exactly 0.5px under the ramp | ramp |
| 5 | `components.css` weights 500/520/560; the scale is 400/550/620/700 | scale |
| 6 | `.cx-svc` is 22px; the workspace screen's rail chip is 24px | screen |
| 7 | form controls — `.cx-input` height+radius, `.cx-btn`/`.cx-seg`/`.cx-modal__ic` radius, `.cx-seg button` height, `.cx-modal__foot` gap — all disagree with the modals screen | screen |

Read the table as the pattern, not the total: rows 4 and 5 are one defect
("the component layer drifted off its own scales") if you prefer to count
that way. What matters is that the component layer and the screens disagree
often enough that you must check, never assume.

### Missing backend — degrade visibly, never fabricate

| Scope | Treatment |
|---|---|
| A whole page/screen | render it, with a **coming-soon banner** at the top |
| A button or icon | render it **disabled** with a `title` of "Coming soon" |
| A single value | render `—` with a `title` explaining it isn't measured yet |
| A whole panel | **omit it**, with a `TODO(#n)` explaining why |

Rules:
- **Never wire a control to plausible-looking data.** A fabricated path is
  worse than a blank one — the panel exists to tell the truth.
- **Never approximate a backend derivation.** Either mirror it exactly (and
  cite the source line) or show nothing.
- Every degraded spot gets a `TODO(#n)` at the call site naming the issue.
- File the issue **before** building the degraded state, so the marker has a
  number.

Use `components/*` helpers where they exist; add `.cx-banner` /
`.cx-soon` styling to the shared component layer rather than per screen.

---

## Phase 3 — Verify by measurement

Run **all five** passes. See `verify.md` for copy-paste recipes, one section
per pass. Skipping any one of these has let a real defect ship.

1. **Geometry** — computed `height`/`padding`/`gap`/`radius`/`font-size` from
   both the rendered design and the app, diffed programmatically. Treat a
   non-numeric value as a failure: every comparison with `NaN` is false, so a
   missing property otherwise reports as a match.
2. **Inventory** — every button label, section label, field, action row, kv
   key, step and checkbox in each surface. *This is the pass that catches a
   three-row menu that should have eight.*
3. **Tokens** — every token the handoff declares exists; every token
   *referenced by the stylesheets* resolves. Derive that list from the sheets;
   a hand-written allowlist only contains names you spelled correctly.
4. **Content** — copy, tooltips, empty states, and the design's voice rules
   (imperative buttons that name the action; `reason · ACTION`; numbers
   specific; sentence case; no emoji). Assert every coming-soon control
   actually carries its tooltip.
5. **Interaction** — hit-test visibility, keyboard operability, focus reveals,
   and that a trigger can close its own popover.

Non-negotiables while verifying:

- **Force hidden surfaces open.** A palette, overview, modal or git chip that
  is not on screen is silently skipped and reported as passing.
- **Hit-test interactive elements** with `elementFromPoint` at their corners.
  "The menu opened" is not "the menu is visible" — a clipped menu opens fine.
- **Check the alignment rules the readme states**, not just per-element
  numbers. Two legitimately-tokenized values can still break a stated shared
  edge.
- **When a diff looks like a defect, check the design before fixing.** Several
  "failures" were the test being wrong: a `narrow` modal really is 440px, a
  title input really is `--fs-md`.

---

## Phase 4 — Ship

1. **Issues** — one per backend gap, assigned to the repo owner. State what
   the design needs, what exists, what is needed, and **what the UI does in
   the meantime**. Cite source files and line numbers.
2. **PR** — document, in the body:
   - what was implemented and what was deliberately left out
   - every handoff contradiction and how it was resolved
   - every backend gap with its issue number
   - what verification was actually run (and what it does *not* cover)
3. **No `Co-Authored-By` trailer** on commits or the PR. This repo does not
   use it.
4. Follow the repo's squash-merge convention; keep the detail in the PR body.

---

## Failure modes seen in the wild

Check each of these before declaring done. All shipped at least once.

**Layout / floating**
- An ancestor's `overflow: hidden` clips a popover — **no z-index escapes a
  clip**. `container-type` compounds it (layout containment makes the element
  a stacking context *and* the containing block). Portal floating menus to
  `<body>` and position from the trigger's viewport rect.
- Hover-only reveals (`opacity: 0`, `display: none`) are invisible to keyboard
  users. Add `:focus-within`.

**State / correctness**
- **Closure capture**: `select(key)` does not update the current render, so a
  launcher closing over "the selection" targets the previous one. Pass
  explicit targets.
- **Snapshot staleness**: a captured node freezes at the status it had when
  clicked. Resolve from the subscribed tree each render.
- **Per-caller hook state** (`useWtContext`) is not shared — read persisted
  state at action time.
- **`busy` defaulting to true** makes a dialog unclosable before its first
  event. Gate dismissal on authoritative state only.
- **Transitional statuses**: `isLive()` excludes `stopping`, so a
  mid-shutdown worktree reads as idle and offers "Start".

**Safety**
- Destructive dialogs must **fail closed**: a failed probe is not "clean".
- Never present a truncated backend list as complete.

**Accessibility**
- `aria-modal="true"` without a focus trap is a false promise; restore focus
  to the opener on close.
- A collapsed region needs `inert`, not just `opacity: 0`.
- Click-only `<span>`s are not operable; nested interactive elements swallow
  each other's keys — gate on `e.target === e.currentTarget`.
- A popover trigger must be able to **close its own popover** — exclude it
  from the outside-click listener.
