// SPINE design tokens — references to the CSS custom properties in
// `tokens.css`. Inline-style callers (Cover placeholder palette, Badge
// borders, etc.) resolve at render time via the browser's CSS-variable
// machinery, so flipping `data-theme` on documentElement reflows the
// entire chrome without any React re-render.
//
// The CSS-var indirection is what makes light-mode possible without
// touching every callsite — see `tokens.css` for the per-theme values.

export const SPINE = {
  // Surfaces
  bg:         "var(--spine-bg)",
  panel:      "var(--spine-panel)",
  canvas:     "var(--spine-canvas)",
  canvasAlt:  "var(--spine-canvas-alt)",
  surface:    "var(--spine-surface)",
  surfaceHi:  "var(--spine-surface-hi)",
  border:     "var(--spine-border)",
  borderSoft: "var(--spine-border-soft)",
  borderHi:   "var(--spine-border-hi)",

  // Ink
  text:       "var(--spine-text)",
  textMid:    "var(--spine-text-mid)",
  textDim:    "var(--spine-text-dim)",
  textFaint:  "var(--spine-text-faint)",
  inkInvert:  "var(--spine-ink-invert)",

  // Accents + semantic
  accent:     "var(--spine-accent)",
  accentHi:   "var(--spine-accent-hi)",
  accentDim:  "var(--spine-accent-dim)",
  oxblood:    "var(--spine-oxblood)",
  ok:         "var(--spine-ok)",
  warn:       "var(--spine-warn)",
  alert:      "var(--spine-alert)",
  link:       "var(--spine-link)",

  // Cover placeholder spine + inset rim
  coverSpineFront: "var(--spine-cover-spine-front)",
  coverSpineBack:  "var(--spine-cover-spine-back)",
  coverInsetRim:   "var(--spine-cover-inset-rim)",

  // Modal / popover layering
  overlay:        "var(--spine-overlay)",
  shadowModal:    "var(--spine-shadow-modal)",
  shadowPopover: "var(--spine-shadow-popover)",
  shadowSoft:     "var(--spine-shadow-soft)",

  // Badge borders (semantic, theme-aware)
  badgeBorderOk:     "var(--spine-badge-border-ok)",
  badgeBorderWarn:   "var(--spine-badge-border-warn)",
  badgeBorderAlert:  "var(--spine-badge-border-alert)",
  badgeBorderAccent: "var(--spine-badge-border-accent)",

  // Typography stacks
  sans:  "var(--spine-font-sans)",
  mono:  "var(--spine-font-mono)",
  serif: "var(--spine-font-serif)",
} as const;

export type SpineToken = keyof typeof SPINE;
