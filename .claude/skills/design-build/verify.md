# Verification recipes

Copy-paste measurement passes for Phase 3 of `design-build`. Run them through
Chrome DevTools MCP (`evaluate_script`) against two pages: the rendered design
and the running app.

```bash
# reference: the design handoff, live
cd <handoff>/project && python3 -m http.server 5310

# subject: the app
npm run dev -- --port 5320
```

Open both, then measure. The design page is authoritative for every number.

---

## 1. Geometry

Extract from the **design** first — never hand-type expected values from
reading CSS, and beware ambiguous selectors (in the Canopod handoff `.pt` is
both a pane tab *and* a service-chip port; scope to `.ptabs .pt`).

```js
() => {
  const g = (sel, ...props) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}: absent`;
    const c = getComputedStyle(el);
    return Object.fromEntries(props.map(p => [p, c[p]]));
  };
  return {
    bar:  g('.wtbar', 'height', 'paddingLeft'),
    chip: g('.svc', 'height', 'paddingLeft', 'gap', 'borderRadius'),
    // …one entry per element you implemented
  };
}
```

Then assert in the **app**, tolerating sub-pixel noise:

```js
() => {
  const DESIGN = { '.cxs-wtbar': {height:'36px', paddingLeft:'10px'} /* … */ };
  const bad = [];
  for (const [sel, want] of Object.entries(DESIGN)) {
    const el = document.querySelector(sel);
    if (!el) { bad.push(`${sel} NOT RENDERED`); continue; }
    const c = getComputedStyle(el);
    for (const [p, exp] of Object.entries(want)) {
      const got = parseFloat(c[p]), e = parseFloat(exp);
      // NaN is the trap: every comparison with NaN is false, so a missing or
      // non-numeric value (auto, "", a typo'd property) would report as a
      // MATCH. Fail on non-finite before comparing.
      if (!Number.isFinite(got) || !Number.isFinite(e))
        bad.push(`${sel}{${p}} NON-NUMERIC design ${exp} ours ${c[p]}`);
      else if (Math.abs(got - e) >= 0.6)
        bad.push(`${sel}{${p}} design ${exp} ours ${c[p]}`);
    }
  }
  return bad.length ? bad : 'ALL MATCH';
}
```

**`NOT RENDERED` is a failure, not a pass.** Force the surface open first.
**A non-numeric value is a failure too** — never let it slip through as equal.

### Stated alignment rules

Per-element numbers can all pass while a stated rule breaks. Assert the rule
itself:

```js
() => {
  const px = s => getComputedStyle(document.querySelector(s)).paddingLeft;
  const g = ['.cxs-wtbar','.cxs-rail','.cx-tabs','.cxs-ltool','.cx-log'].map(px);
  return new Set(g).size === 1 ? `aligned at ${g[0]}` : `MISALIGNED: ${g}`;
}
```

---

## 2. Inventory

**The pass that catches missing content.** Walk every flow in the design,
capture what each surface renders, then do the same in the app and compare
lists — not counts.

```js
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const f of [...document.querySelectorAll('.flow')]) {
    f.click(); await sleep(450);
    const m = document.querySelector('.mod');       // app: '.cx-modal'
    if (!m) continue;
    out[f.textContent.trim()] = {
      title:        m.querySelector('.mt b')?.textContent,
      width:        getComputedStyle(m).width,
      footButtons:  [...m.querySelectorAll('.mf .btn')].map(b => b.textContent.trim()),
      footHint:     m.querySelector('.mf .hint')?.textContent.trim(),
      sectionLabels:[...m.querySelectorAll('.flab')].map(l => l.textContent.trim()),
      checkboxes:   [...m.querySelectorAll('.chk .ct b')].map(b => b.textContent.trim()),
      actionRows:   [...m.querySelectorAll('.act-i')].map(b => b.textContent.trim()),
      kvKeys:       [...m.querySelectorAll('.kv dt')].map(d => d.textContent.trim()),
      steps:        [...m.querySelectorAll('.step .tx')].map(s => s.textContent.trim()),
      inputs:       m.querySelectorAll('input,textarea,select').length,
    };
  }
  return out;
}
```

Menus and popovers need the same treatment — count **rows and separators**:

```js
() => {
  const pop = document.querySelector('.cx-pop[role="menu"]');
  return {
    width: Math.round(pop.getBoundingClientRect().width),
    separators: pop.querySelectorAll('.cx-pop__sep').length,
    items: [...pop.querySelectorAll('.cx-pop__item')].map(b => b.textContent.trim()),
  };
}
```

> A dialog that will not close wedges this walk and every later surface reports
> the stuck one's contents. If several results look identical, suspect that
> before suspecting the app.

---

## 3. Tokens

Declared-vs-present:

```bash
cat <handoff>/tokens/*.css | grep -oE "^\s*--[a-z0-9-]+:" | tr -d ' :' | sort -u > /tmp/d.txt
grep -oE "^\s*--[a-z0-9-]+:" src/styles/tokens.css | tr -d ' :' | sort -u > /tmp/o.txt
comm -23 /tmp/d.txt /tmp/o.txt          # missing from ours
```

Resolution — a `var()` typo falls back silently. Deriving the list from the
stylesheets is the whole point: a hand-written allowlist only contains names
you spelled correctly, so it can never catch the typo it claims to prove
against.

Not every token lives on `:root`. Scoped properties (`--gutter` on the main
pane, `--tblmin` on the overview body) resolve only on their own subtree, so
a root-only check reports them as broken every run and trains you to ignore
it. Resolve each reference **where it is used**.

```js
// every token REFERENCED by our stylesheets, resolved at its own use site
() => {
  const refs = new Map();                       // token -> a selector using it
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }  // cross-origin
    const walk = (rs) => { for (const r of rs) {
      if (r.style && r.selectorText) for (const p of r.style) {
        const v = r.style.getPropertyValue(p);
        for (const m of v.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g))
          if (!refs.has(m[1])) refs.set(m[1], r.selectorText);
      }
      if (r.cssRules) walk(r.cssRules);
    }};
    walk(rules);
  }
  const root = getComputedStyle(document.documentElement);
  const unresolved = [];
  for (const [token, selector] of refs) {
    if (root.getPropertyValue(token).trim()) continue;          // global
    // scoped: resolve on an element the referencing rule actually matches
    let el = null;
    for (const s of selector.split(',')) {
      try { el = document.querySelector(s.trim()); } catch { /* :hover etc */ }
      if (el) break;
    }
    if (!el || !getComputedStyle(el).getPropertyValue(token).trim())
      unresolved.push({ token, selector, reachable: !!el });
  }
  return { referenced: refs.size, unresolved };   // unresolved must be empty
}
```

> A `var()` with a fallback (`var(--x, 6px)`) still renders when `--x` is
> missing. This finds the missing definition regardless.
>
> `reachable: false` means the recipe could not find an element to test on —
> render the surface that uses it before trusting the result.

Literal audit — run before making any claim about coverage.

Two traps make a naive audit report cleaner than reality:

- `grep -v "var(--"` **hides mixed declarations**. `padding: var(--sp-3) 11px`
  contains a literal and is skipped. Real drift hid behind exactly this.
- Scanning one stylesheet says nothing about the others.

```bash
# px literals per stylesheet, KEEPING mixed token+literal declarations and
# excluding only custom-property definitions
for f in src/styles/*.css; do
  n=$(grep -oE "^\s+[a-z-]+: *[^;]+;" "$f" | grep -vE "^\s*--" \
      | grep -oE "\b[0-9]+(\.[0-9]+)?px" | wc -l | tr -d ' ')
  printf "  %-28s %s px literals\n" "$(basename $f)" "$n"
done

# then list them, so each can be judged rather than counted
grep -nE "^\s+[a-z-]+: *[^;]+;" src/styles/<sheet>.css | grep -E "[0-9]+px" | grep -vE "^\s*--"

# raw colours anywhere
grep -ohE "rgba?\([0-9., ]+\)|#[0-9a-fA-F]{3,8}\b" src/styles/*.css | sort | uniq -c
```

---

## 4. Content

Geometry can match perfectly while the copy is wrong. Compare text, not just
boxes — and against the design's stated voice rules.

```js
// run on BOTH pages and diff the results
() => {
  const t = el => el?.textContent.replace(/\s+/g, ' ').trim();
  return {
    buttons:   [...document.querySelectorAll('button')].map(t).filter(Boolean),
    tooltips:  [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title')),
    labels:    [...document.querySelectorAll('.cxm-flab,.cxs-grp,.cx-label')].map(t),
    empties:   [...document.querySelectorAll('.cxs-empty .et,.cxs-empty .es')].map(t),
    hints:     [...document.querySelectorAll('.cxm-fhint,.cx-modal__hint')].map(t),
  };
}
```

Then check the handoff's content rules by hand — they are judgement, not regex:

- buttons name their **specific action** ("Restart Server", not "OK"/"Confirm")
- an action carries its reason as `reason · ACTION`, lowercase, not repeating
  the button
- confirmations are **past tense** and unremarkable, no exclamation marks
- numbers are **specific** ("18 passed · 0 failed"), never "some"/"a few"
- warnings say **what is lost**, concretely, with the actual list
- **sentence case** everywhere except tracked uppercase section labels
- **no emoji**; Unicode arrows and geometric bullets are typography, not
  decoration
- empty states **name the next step**, never a bare "Nothing here"

Every coming-soon control must carry its tooltip — assert it rather than
trusting it:

```js
() => [...document.querySelectorAll('[data-soon]')]
  .filter(el => !/coming soon/i.test(el.getAttribute('title') || ''))   // must be empty
```

---

## 5. Interaction

Existence is not usability.

```js
// visible, not merely present — a clipped menu still "opens".
// All FOUR corners: clipping is usually one-sided, so testing two can pass a
// menu cut off at top-right or bottom-left.
() => {
  const el = document.querySelector('.cx-pop[role="menu"]');
  const r = el.getBoundingClientRect();
  const hit = (x,y) => { const t = document.elementFromPoint(x,y); return !!t && el.contains(t); };
  const corners = {
    topLeft:     hit(r.left + 4,  r.top + 4),
    topRight:    hit(r.right - 4, r.top + 4),
    bottomLeft:  hit(r.left + 4,  r.bottom - 4),
    bottomRight: hit(r.right - 4, r.bottom - 4),
  };
  return { corners, fullyVisible: Object.values(corners).every(Boolean) };
}
```

```js
// a trigger must be able to close what it opened
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t = document.querySelector('.cxs-attn');
  t.click(); await sleep(300);
  const opened = !!document.querySelector('.cxs-attnpop');
  t.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); t.click(); await sleep(300);
  return { opened, closes: !document.querySelector('.cxs-attnpop') };
}
```

```js
// keyboard reveals and inert regions
() => ({
  rowActionsOnFocus: (() => {
    const r = document.querySelector('.cxs-rowact');
    const before = getComputedStyle(r).opacity;
    r.querySelector('button')?.focus();
    return before === '0' && getComputedStyle(r).opacity === '1';
  })(),
  collapsedIsInert: document.querySelector('.cxs-side.is-hidden')?.hasAttribute('inert'),
})
```

Cross-target actions — prove the effect landed **and did not leak**:

```js
// act on worktree B while A is selected; B gains the session, A gains nothing
```

---

## Reporting

State what you measured **and what you did not**. "The modals match" is only
true for the properties in your spec and the surfaces you could open. Name the
dialogs you could not reach and why.

Two apparent mismatches are usually the test, not the code — check the design
before fixing: modifier-driven sizes (`narrow` → 440px) and deliberate
per-instance overrides (a title input at `--fs-md`).
