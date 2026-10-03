// Appearance settings — theme + density + accent (the "Appearance" section of
// Settings).
//
// Persisted in localStorage, which every Canopod window shares (they're all the
// same origin), and applied as root data-attributes that tokens.css keys off.
// Appearance applies LIVE and instantly — it never goes through the Settings
// save step. A `storage` event re-applies it in the app's other windows, and a
// `prefers-color-scheme` listener re-resolves "system" when the OS flips.
//
// The updater / crash-report toggles (#78) stay coming-soon — they need a
// backend.
export type Theme = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";
export type Accent = "teal" | "green" | "amber" | "violet";

export interface Appearance {
  theme: Theme;
  density: Density;
  accent: Accent;
  /** app-wide text zoom (⌘+ / ⌘- / ⌘0) — multiplies every `--fs-*` token */
  fontScale: number;
}

const KEY = "canopod.appearance";
const THEMES: Theme[] = ["dark", "light", "system"];
const ACCENTS: Accent[] = ["teal", "green", "amber", "violet"];

// Font zoom is a multiplier on the size ramp, clamped so text stays legible and
// the layout never collapses. 10% steps land on clean values off the 1.0 base.
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1;

/** Round to one decimal and clamp — keeps repeated nudges off floating dust. */
function normScale(n: number): number {
  if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT;
  const r = Math.round(n * 10) / 10;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, r));
}

export function getAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Appearance>;
      return {
        theme: THEMES.includes(p.theme as Theme) ? (p.theme as Theme) : "dark",
        density: p.density === "compact" ? "compact" : "comfortable",
        accent: ACCENTS.includes(p.accent as Accent) ? (p.accent as Accent) : "teal",
        fontScale: normScale(typeof p.fontScale === "number" ? p.fontScale : FONT_SCALE_DEFAULT),
      };
    }
  } catch {
    /* corrupt or unavailable storage — fall through to defaults */
  }
  return { theme: "dark", density: "comfortable", accent: "teal", fontScale: FONT_SCALE_DEFAULT };
}

/** "system" resolves to the OS scheme; everything else is literal. */
function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

export function applyAppearance(a: Appearance = getAppearance()): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(a.theme);
  root.dataset.density = a.density;
  root.dataset.accent = a.accent;
  root.style.setProperty("--font-scale", String(a.fontScale));
}

/** Bump the app-wide text zoom by whole steps (⌘+ / ⌘-). Persists + applies
    live across every Canopod window. Returns the resolved scale. */
export function nudgeFontScale(steps: number): number {
  const next = normScale(getAppearance().fontScale + steps * FONT_SCALE_STEP);
  return setAppearance({ fontScale: next }).fontScale;
}

/** Reset text zoom to 100% (⌘0). */
export function resetFontScale(): number {
  return setAppearance({ fontScale: FONT_SCALE_DEFAULT }).fontScale;
}

/** Persist + apply live, and notify this window's UI and the app's others. */
export function setAppearance(patch: Partial<Appearance>): Appearance {
  const next = { ...getAppearance(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — still apply for this session */
  }
  applyAppearance(next);
  window.dispatchEvent(new CustomEvent("canopod:appearance", { detail: next }));
  return next;
}

/** Apply on startup and keep in sync with other windows + the OS scheme. */
export function initAppearance(): void {
  applyAppearance();
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyAppearance();
  });
  // re-resolve "system" when the OS theme flips (a no-op for explicit themes)
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => applyAppearance());
}
