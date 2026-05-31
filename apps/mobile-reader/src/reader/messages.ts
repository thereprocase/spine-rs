// Wire format between the RN reader screen and the WebView's bootstrap.
// Mirrors scripts/reader-bootstrap.js — keep in sync. The bootstrap-side
// tap/swipe paths were removed in 0.2.5 (RN PanResponder overlay owns
// gestures); their message types are no longer emitted.

import type { ReaderSettings } from "../store/prefs";
import { readerFontForCategory } from "./fonts";
import { SPINE_THEMES } from "../themes";

export interface ReaderPayload {
  bg: string;
  ink: string;
  dim: string;
  rule: string;
  accent: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  justify: boolean;
  hyphenate: boolean;
  dropCap: boolean;
  mode: "paginated" | "scroll";
}

export function settingsToPayload(s: ReaderSettings): ReaderPayload {
  const theme = SPINE_THEMES[s.theme];
  const font = readerFontForCategory(s.fontFamily, s.fontMap);
  return {
    bg: theme.readerBg,
    ink: theme.readerInk,
    dim: theme.readerDim,
    rule: theme.readerRule,
    accent: theme.accent,
    fontFamily: font.cssFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    justify: s.justify,
    hyphenate: s.hyphenate,
    dropCap: s.dropCap,
    mode: s.mode,
  };
}

export interface TocItem {
  label: string;
  href: string;
  subitems?: TocItem[];
}

/** Pixel rect in iframe coords. RN converts to screen coords by adding
 * the WebView's onLayout origin. */
export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width?: number;
  height?: number;
}

export type WebToNative =
  | { type: "boot" }
  | { type: "ready" }
  | { type: "rendered" }
  | {
      type: "location";
      cfi: string | null;
      href: string | null;
      percentage: number;
      page: number | null;
      totalPages: number | null;
    }
  | { type: "toc"; items: TocItem[] }
  | { type: "metrics"; totalChars: number }
  | {
      // Drag-select event — fires once per coalesced selection change
      // (~60ms debounce in the bootstrap). cfiRange may be empty if
      // epubjs couldn't anchor; the SelectionBar still gets to show
      // Copy / Look up / Share for non-anchorable text.
      type: "selection";
      text: string;
      cfiRange: string;
      textBefore: string;
      textAfter: string;
      rect: SelectionRect | null;
    }
  | { type: "selectionEnd" }
  | {
      // Long-press event — fires once when the user has held a single
      // finger for ~450ms with <8px drift. Bootstrap programmatically
      // selects the word so the user sees their target highlighted
      // when the dictionary sheet opens.
      type: "longpress";
      word: string;
      cfi: string;
      rect: SelectionRect | null;
    }
  | { type: "highlightTap"; id: string }
  | {
      // Bootstrap-detected single tap inside the iframe. Coords are
      // SCREEN-relative (the bootstrap reads its own iframe origins
      // and reports back where the user touched on the device).
      // RN classifies left/center/right and either page-turns or
      // toggles chrome — same behavior as the old PanResponder
      // tap-zones, but the WebView gets the touch first so Android's
      // native long-press selection (with drag handles) engages
      // naturally before the bootstrap decides this was a tap.
      type: "tap";
      x: number;
      y: number;
    }
  | {
      // Bootstrap-detected horizontal swipe (page-turn intent).
      // Same architectural reason as `tap`: the cooperative
      // responder leaves touches with the WebView so Android-native
      // selection engages — which means the RN PanResponder no
      // longer sees swipes either. Bootstrap detects them in the
      // iframe touchmove handler instead.
      type: "swipe";
      dir: "prev" | "next";
    }
  | {
      // Visible debug message routed to an in-reader overlay. Only
      // emitted when DEBUG instrumentation is on; the production
      // path stays silent. Used to bisect the long-press chain
      // (PanResponder → injectJavaScript → bootstrap → iframe walk
      // → wordAtPoint → longpress post). Remove or gate behind a
      // pref once the gesture stack settles.
      type: "debug";
      message: string;
    }
  | { type: "error"; message: string };

/** Subset of Highlight pushed to the WebView for rendering. We don't
 * ship `text` / snippets / timestamps — the bootstrap only needs
 * what's required to draw the wash + report taps back. */
export interface HighlightPayload {
  id: string;
  cfiRange: string;
  color: "yellow" | "pink" | "green" | "blue" | "orange";
}

export type NativeToWeb =
  | {
      type: "open";
      /** file:// URL the WebView fetches the EPUB from. Stays on disk —
       * no base64 round-trip through the JS heap. */
      url: string;
      /** On-disk EPUB size. Lets the bootstrap avoid whole-book work
       * that is known to wedge Android WebView on large compendiums. */
      sizeBytes: number | null;
      settings: ReaderPayload;
      /** EPUB CFI to resume at; null means open at the start. */
      startAt: string | null;
    }
  | { type: "settings"; settings: ReaderPayload }
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; target: string }
  | { type: "seek"; percentage: number }
  | { type: "clearSelection" }
  | { type: "copySelection" }
  | { type: "setHighlights"; highlights: HighlightPayload[] }
  | {
      // Same shape as requestLongPress (RN-driven, screen coords),
      // but for taps. On a no-movement tap, RN asks "is there a
      // highlight at (x, y)?" The bootstrap walks the iframe DOM
      // for an SVG/HTML element with className containing
      // `spine-hl-`; if hit, looks up the matching attached
      // highlight and posts a `highlightTap` event. Without this,
      // existing highlights are visually present but un-tappable
      // because the gesture overlay walls off the iframe's own
      // click handlers.
      type: "probeHighlightAt";
      x: number;
      y: number;
    }
  | {
      // Optional cheat-up: scroll the iframe so the bottom-of-page
      // selection sits in the upper half, leaving room for the
      // SelectionBar at the bottom. delta is in CSS pixels, positive
      // = scroll content up. Pass 0 to restore.
      type: "cheatUp";
      delta: number;
    }
  | {
      // The RN PanResponder owns every touch the user makes — the
      // iframe never sees a touchstart, so the bootstrap can't run
      // its own long-press detection. Instead, the PanResponder
      // detects the long-press itself (no movement for ~500ms) and
      // sends the touch coords down here. The bootstrap uses
      // elementFromPoint on the outer document to locate the iframe,
      // translates to iframe coords, and runs the same wordAtPoint +
      // programmatic-select + post-back path as if the iframe had
      // detected the gesture itself.
      //
      // Coords are SCREEN-relative. The bootstrap subtracts whatever
      // it needs to land on iframe-document coords.
      type: "requestLongPress";
      x: number;
      y: number;
    };

/** Serialize a NativeToWeb message into a WebView injectJavaScript payload. */
export function buildInjectScript(msg: NativeToWeb): string {
  const json = JSON.stringify(msg).replace(/<\//g, "<\\/");
  return `try { window.SpineReader && window.SpineReader.handle(${JSON.stringify(json)}); } catch(e){}; true;`;
}
