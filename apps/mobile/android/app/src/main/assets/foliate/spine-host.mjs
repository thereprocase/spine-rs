// Spine reader host module. Loaded by index.html as a single
// `<script type="module" src="./spine-host.mjs">` tag so the host
// page itself stays markup-only and the CSP can keep `script-src 'self'`
// without an `'unsafe-inline'` carve-out.
//
// What lives here:
//   1. Bridge handshake with window.SpineBridge (Kotlin side in
//      ReaderActivity.kt). Exposes the EPUB filename + a base URL
//      under which per-resource fetches resolve through
//      WebViewAssetLoader → EpubResourcePathHandler.
//   2. Per-resource loadText / loadBlob / getSize callbacks for
//      foliate-js's `new EPUB({...}).init()`. EPUB bytes never cross
//      the JS bridge as a single payload — every fetch streams one
//      zip entry from app-private storage. That's how the
//      whole-archive class of bug stays closed (lane non-negotiable
//      #1 in CLAUDE.md).
//   3. Visible status / error overlays so a real-device user can see
//      what's wrong without a developer tether.
//   4. Selection / annotation bridging for N6: long-press text in the
//      reader, the iframe's selection becomes a CFI range, that goes
//      back to Kotlin via window.SpineBridge.onSelection so a
//      Compose SelectionBar can show. Highlights round-trip through
//      window.spineHost.applyHighlights / .removeHighlight.

import './view.js'
import { EPUB } from './epub.js'
import { Overlayer } from './overlayer.js'

const view = document.getElementById('view')
const statusEl = document.getElementById('status')
const statusLabel = document.getElementById('status-label')
const errorEl = document.getElementById('error')
const errorTitle = document.getElementById('error-title')
const errorDetail = document.getElementById('error-detail')

function setStatus(label) {
  if (!label) { statusEl.hidden = true; return }
  statusLabel.textContent = label
  statusEl.hidden = false
}

function showError(title, detail) {
  errorTitle.textContent = title
  errorDetail.textContent = detail
  errorEl.hidden = false
  setStatus(null)
  view.style.display = 'none'
}

// Returns up to N chars of text immediately preceding `range`'s start
// in the same document. Used as fuzzy-match anchor when a future
// engine swap forces re-resolution of a CFI that no longer matches
// (sprint plan pin #2 anchor_text / before / after).
function contextBefore(range, n = 80) {
  try {
    const r = document.createRange ? document.createRange() : null
    if (!r || !range) return ''
    const doc = range.startContainer.ownerDocument
    if (!doc) return ''
    r.setStart(doc.body || doc.documentElement, 0)
    r.setEnd(range.startContainer, range.startOffset)
    return r.toString().slice(-n)
  } catch { return '' }
}
function contextAfter(range, n = 80) {
  try {
    const doc = range.endContainer.ownerDocument
    if (!doc) return ''
    const r = doc.createRange()
    const root = doc.body || doc.documentElement
    r.setStart(range.endContainer, range.endOffset)
    r.setEndAfter(root)
    return r.toString().slice(0, n)
  } catch { return '' }
}

// Track the currently-loaded section index + range so SpineBridge
// can synthesize a CFI for the active selection without keeping a
// reference to a Range that the WebView might recycle.
let currentSectionIndex = 0
let currentSelectionPayload = null

// SPINE-PATCH 0.4.1 (N3.5 follow-up): foliate's Paginator has a
// private `#locked` flag. `#turnPage()` sets it true, awaits the
// scroll-or-cross-chapter pipeline, then releases. Crossing a
// chapter boundary takes ~1s while the new spine-item iframe loads
// — every view.next() called during that window returns immediately
// with no effect (#locked === true → bail). Users tapping quickly
// across a chapter boundary saw 6+ phantom taps before pages
// resumed advancing.
//
// Wrap each turn so it's await-serialized at our layer too. Buffer
// at most ONE follow-up tap so a fast double-tap registers as
// "advance two pages" rather than dropping the second; deeper
// queues let the user run away from foliate's render budget. After
// each turn resolves we drain the buffer; if more pile up beyond
// the cap they're dropped, matching foliate's own back-pressure
// policy.
const TURN_QUEUE_CAP = 1
let turnInFlight = false
let queuedTurns = 0
let queuedTurnDir = 0  // 1 = next, -1 = prev; only honored if
                       // queuedTurns > 0 and matches the current
                       // direction. Mixed-direction taps clear.

async function pumpTurnQueue() {
  while (queuedTurns > 0) {
    const dir = queuedTurnDir
    queuedTurns = 0
    queuedTurnDir = 0
    turnInFlight = true
    if (DIAG_TAP_ZONE) trace('pump dispatch', dir === 1 ? 'next' : 'prev')
    try {
      if (dir === 1) {
        await view.next()
      } else if (dir === -1) {
        // SPINE-PATCH 0.4.1 round 3 — REACTIVE prev escalation.
        // Foliate's #scrollPrev called from the first visual page of
        // a chapter sometimes scrolls *within* the chapter to earlier
        // CFI nodes that render on the same visible column (so the
        // user sees no movement). The previous round's PRE-CHECK
        // escalation crossed sections too aggressively and rendered
        // a black iframe in some cases. This time we let foliate try
        // its normal prev FIRST, sample a settle window, and only
        // force a section cross if neither the section index nor the
        // renderer page changed.
        const r = view.renderer
        const beforeIdx = currentSectionIndex
        const beforePage = (r && typeof r.page === 'number') ? r.page : -1
        if (DIAG_TAP_ZONE) trace('prev pre',
          JSON.stringify({ idx: beforeIdx, page: beforePage }))
        await view.prev()
        await new Promise(res => setTimeout(res, 80))
        const afterIdx = currentSectionIndex
        const afterPage = (r && typeof r.page === 'number') ? r.page : -1
        if (DIAG_TAP_ZONE) trace('prev post',
          JSON.stringify({ idx: afterIdx, page: afterPage }))
        const noOp = afterIdx === beforeIdx && afterPage === beforePage
        if (noOp && view?.book?.sections) {
          let prevIdx = -1
          for (let i = beforeIdx - 1; i >= 0; i--) {
            if (view.book.sections[i]?.linear !== 'no') { prevIdx = i; break }
          }
          if (DIAG_TAP_ZONE) trace('prev escalate', JSON.stringify({ prevIdx }))
          if (prevIdx >= 0) {
            try {
              await r.goTo({ index: prevIdx, anchor: () => 1 })
            } catch (e) {
              if (DIAG_TAP_ZONE) trace('prev escalate threw', String(e?.message || e))
            }
          }
        }
      }
      if (DIAG_TAP_ZONE) trace('pump completed', dir === 1 ? 'next' : 'prev')
    } catch (e) {
      console.warn('view.', dir === 1 ? 'next' : 'prev', 'threw', e?.message || e)
      if (DIAG_TAP_ZONE) trace('pump THREW', dir === 1 ? 'next' : 'prev', String(e?.message || e))
    }
    turnInFlight = false
  }
}

function requestTurn(dir) {
  if (dir !== 1 && dir !== -1) return
  if (!turnInFlight) {
    queuedTurns = 1
    queuedTurnDir = dir
    pumpTurnQueue()
    return
  }
  // In flight. Buffer one tap of the same direction; drop the rest.
  if (queuedTurnDir !== dir) {
    queuedTurns = 0
    queuedTurnDir = 0
  }
  if (queuedTurns < TURN_QUEUE_CAP) {
    queuedTurns++
    queuedTurnDir = dir
  }
}

// Gate for the chatty tap-zone diagnostics. Flip to true to follow
// the routing math in logcat. Off by default; the previous
// "soak-then-remove" comment was a placeholder that would have rotted
// (verified via external model review, 2026-04-28).
const DIAG_TAP_ZONE = true

function publishSelection(payload) {
  currentSelectionPayload = payload
  try {
    if (window.SpineBridge && typeof window.SpineBridge.onSelection === 'function') {
      window.SpineBridge.onSelection(JSON.stringify(payload || null))
    }
  } catch (e) {
    console.warn('SpineBridge.onSelection threw', e)
  }
}

function publishLocator(locator) {
  try {
    if (window.SpineBridge && typeof window.SpineBridge.onLocator === 'function') {
      window.SpineBridge.onLocator(JSON.stringify(locator || null))
    }
  } catch (e) {
    console.warn('SpineBridge.onLocator threw', e)
  }
}

// Wire selection + click handlers onto each spine-item iframe doc.
// view.js emits a 'load' detail with { doc, index } each time a new
// spine item lands; we attach our listeners then.
function attachToDoc(doc, index) {
  const onSelectionChange = () => {
    const sel = doc.defaultView?.getSelection?.()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (currentSelectionPayload) publishSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const text = sel.toString()
    if (!text || !text.trim()) {
      if (currentSelectionPayload) publishSelection(null)
      return
    }
    let cfi
    try { cfi = view.getCFI(index, range) } catch (_) { cfi = null }
    if (!cfi) return
    publishSelection({
      engine: 'foliate',
      schema: 'epubcfi-range',
      locator: cfi,
      anchorText: text,
      before: contextBefore(range, 80),
      after: contextAfter(range, 80),
    })
  }
  doc.addEventListener('selectionchange', onSelectionChange)
  // Tap-zone routing: left 30% → prev, right 30% → next, middle 40%
  // → toggle Compose chrome via SpineBridge. Foliate handles swipes
  // natively (touchstart/move/end → snap); we only fire on a clean
  // click. Skip when:
  //   - the click is on a link / annotation overlay (foliate's own
  //     handlers paginate the navigation),
  //   - the click ends a text selection (selectionchange already
  //     fired; we don't want to also page-turn),
  //   - the user tapped within ~16 dp of the edge (Android 15
  //     gesture-nav back-swipe lives there).
  // Always emits a locator afterwards so the chrome's bookmark icon
  // has a CFI handle.
  // (code review finds.)
  // SPINE-PATCH 0.3.18: foliate's #onTouchEnd unconditionally calls
  // snap() in a requestAnimationFrame, which performs a small scroll
  // animation. Android WebView treats any post-touch scroll as a
  // movement that suppresses the synthetic `click` event — so the
  // previous `click` listener silently never fired for tap zones.
  // Switch to pointerdown/pointerup with movement tracking so we
  // route taps regardless of foliate's snap.
  // Edge guard was originally 24px to avoid Android 15 gesture-nav
  // back-swipe, but back-swipe only fires on actual swipes — a clean
  // down+up tap at the same point is never a back-gesture. Keeping
  // the guard threw away every right-thumb tap on the next-page band
  // (Pixel 9 Pro: x≈378 with w=393). Dropped to 0 in 0.4.1; the only
  // edge cases remaining (literal x=0 / x=w from a click on the page
  // border) are rare and harmless.
  const EDGE_GUARD_PX = 0
  const TAP_SLOP_PX = 12
  const TAP_MAX_MS = 400
  let tapStart = null
  // SPINE-PATCH 0.4.2: track CUMULATIVE pointer travel via pointermove,
  // not just net (pointerup - pointerdown) displacement. Foliate's
  // #onTouchMove keeps the gesture alive (preventDefault on touchmove,
  // scrollBy column-drag) but lets pointer events fire normally. A
  // short swipe that snaps back to the same page, or any swipe whose
  // touchend lands near touchstart after column-drag, was leaking
  // through the net-displacement check and toggling chrome — so the
  // user saw "swipe → page turns AND chrome flickers" on every page.
  // Cancel the tap as soon as any sample exceeds slop, regardless of
  // where the finger eventually lifts.
  const cancelTap = () => { tapStart = null }
  doc.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    tapStart = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }
  }, { capture: true })
  doc.addEventListener('pointermove', e => {
    const start = tapStart
    if (!start) return
    const dx = Math.abs(e.clientX - start.x)
    const dy = Math.abs(e.clientY - start.y)
    if (dx > TAP_SLOP_PX || dy > TAP_SLOP_PX) {
      start.moved = true
      tapStart = null
    }
  }, { capture: true })
  doc.addEventListener('pointercancel', cancelTap, { capture: true })
  doc.addEventListener('pointerup', e => {
    const start = tapStart
    tapStart = null
    if (!start || start.moved) return
    const dx = Math.abs(e.clientX - start.x)
    const dy = Math.abs(e.clientY - start.y)
    const dt = e.timeStamp - start.t
    if (dx > TAP_SLOP_PX || dy > TAP_SLOP_PX || dt > TAP_MAX_MS) return
    const target = e.target
    if (target && target.closest && (
      target.closest('a, [href]') ||
      target.closest('[data-annotation-id], [data-annotation-value]')
    )) return
    try {
      const sel = doc.defaultView?.getSelection?.()
      if (sel && sel.toString && sel.toString().length > 0) return
    } catch (_) {}
    // SPINE-PATCH 0.4.1 (N3.5 follow-up): Foliate's paginator lays
    // the iframe out as horizontally-scrolling columns. The iframe's
    // documentElement is innerWidth = column-width × column-count
    // wide (typically 5–10× the visible screen), so e.clientX is in
    // that wide coordinate space — it includes the current page's
    // column offset, which makes every tap look left-zone or
    // edge-guard depending on which page is showing. e.screenX is
    // screen-relative and unaffected by the column-scroll; use it
    // when available. Modulo of clientX is the fallback for older
    // WebView builds that don't expose screenX correctly.
    const w = window.innerWidth || doc.defaultView?.innerWidth || 0
    if (w > 0) {
      const screenX = e.screenX
      const x = (typeof screenX === 'number' && screenX >= 0 && screenX <= w * 1.1)
        ? screenX
        : ((e.clientX % w) + w) % w
      const inEdgeBand = x < EDGE_GUARD_PX || x > w - EDGE_GUARD_PX
      if (DIAG_TAP_ZONE) trace('tap-zone', JSON.stringify({
        x, raw: e.clientX, screenX, w, inEdgeBand,
        zone: x < w*0.30 ? 'L' : x >= w*0.70 ? 'R' : 'M',
      }))
      if (!inEdgeBand) {
        if (x <= w * 0.30) {
          if (DIAG_TAP_ZONE) trace('tap-zone → prev')
          requestTurn(-1)
        } else if (x >= w * 0.70) {
          if (DIAG_TAP_ZONE) trace('tap-zone → next')
          requestTurn(1)
        } else if (window.SpineBridge && typeof window.SpineBridge.toggleChrome === 'function') {
          if (DIAG_TAP_ZONE) trace('tap-zone → toggleChrome')
          try { window.SpineBridge.toggleChrome() } catch (_) {}
        }
        // SPINE-PATCH 0.3.26 (N3.5): every successful tap-zone tap
        // is "user is reading" — re-arm SessionTimer's active deadline
        // so a 5-minute long-page hold doesn't get classified as idle
        // when the user is in fact still paging. Best-effort; older
        // bundles without the bridge method silently no-op.
        try { window.SpineBridge?.notePageEvent?.() } catch (_) {}
      }
    }
    try {
      const cfi = view.getCFI(index)
      if (cfi) publishLocator({ engine: 'foliate', schema: 'epubcfi', locator: cfi })
    } catch (_) {}
  }, { capture: true })
}

// Heavy lifecycle tracing. Every step that could silently fail emits
// a console line so a black screen on device leaves a trail in logcat
// (filter `ReaderWebJS:V`).
const T0 = Date.now()
function trace(...args) {
  console.log('[trace +' + (Date.now() - T0) + 'ms]', ...args)
}

async function main() {
  trace('main entry, document.readyState=', document.readyState)
  trace('viewport', window.innerWidth, 'x', window.innerHeight)
  const bridge = window.SpineBridge
  if (!bridge || typeof bridge.getBookUrl !== 'function' || typeof bridge.getEpubFilename !== 'function') {
    showError(
      'Reader bridge unavailable',
      'window.SpineBridge is not installed. The Android host did not ' +
      'attach the JavaScript bridge before loading this page. This ' +
      'is a programmer error in ReaderActivity, not an EPUB problem.',
    )
    return
  }
  const baseUrl = bridge.getBookUrl()
  const filename = bridge.getEpubFilename()
  if (!baseUrl || !filename) {
    showError(
      'Reader bridge incomplete',
      `getBookUrl()=${JSON.stringify(baseUrl)}, getEpubFilename()=${JSON.stringify(filename)}`,
    )
    return
  }

  // Fetch wrapper that catches the bare "Failed to fetch" / "TypeError"
  // reject from WebView and rethrows with the full URL we tried, so
  // the on-screen error tells you which resource the reader couldn't
  // find. Without this you get a five-word browser-default message
  // and have to bisect by hand.
  async function fetchAt(path) {
    const url = baseUrl + path
    console.log('[spine-host] fetch', path, '→', url)
    try {
      const r = await fetch(url)
      console.log('[spine-host] fetch result', path, 'ok=' + r.ok, 'status=' + r.status)
      return r
    } catch (e) {
      console.warn('[spine-host] fetch threw', path, e?.message || e)
      throw new Error(`fetch failed for ${path} (url=${url}): ${e?.message || e}`)
    }
  }

  // Many real-world EPUBs (especially fanfic exports — HPMOR, AO3
  // bundles, Calibre re-exports) ship OPF / NCX / container.xml
  // documents with bare `&` characters in title / author / dc:rights
  // metadata. Strict XML parsers (libxml2-via-DOMParser) reject these
  // with `xmlParseEntityRef: no name`, leaving the user staring at a
  // misleading "Malformed or unsupported EPUB" — the EPUB is malformed
  // by spec, but every other reader (Calibre, Apple Books, Readium)
  // handles it via lenient parsing. Mirror that behaviour: detect the
  // path is an XML document, then escape any `&` that isn't already
  // part of a well-formed entity reference. (Spine Alpha 0.1.2 fix.)
  function isXmlPath(p) {
    return /\.(opf|ncx|xml|xhtml)$/i.test(p) ||
      p === 'META-INF/container.xml'
  }
  // `&` not followed by a known entity name (or numeric / hex entity)
  // and a `;`. Matches the bare `&` that DOMParser rejects, leaves
  // valid entities (`&amp;`, `&#x2014;`, `&lt;`, etc.) untouched.
  const BARE_AMP = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g

  function lenientXml(text) {
    return text.replace(BARE_AMP, '&amp;')
  }

  async function loadText(path) {
    const r = await fetchAt(path)
    // 404 is "not present" not "broken" — foliate-js's #loadXML
    // expects null for optional files (META-INF/encryption.xml,
    // ibooks display-options, etc.) rather than a thrown error.
    // Returning null lets the loader skip and continue.
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${path}`)
    const text = await r.text()
    return isXmlPath(path) ? lenientXml(text) : text
  }

  async function loadBlob(path, type) {
    const r = await fetchAt(path)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${path}`)
    const blob = await r.blob()
    return type ? new Blob([blob], { type }) : blob
  }

  async function getSize(path) {
    try {
      const r = await fetch(baseUrl + path, { method: 'HEAD' })
      if (r.ok) {
        const len = r.headers.get('Content-Length')
        if (len != null) return Number(len)
      }
      const g = await fetchAt(path)
      if (!g.ok) return 0
      return (await g.arrayBuffer()).byteLength
    } catch {
      return 0
    }
  }

  setStatus('Reading EPUB structure…')
  trace('about to call EPUB().init()')

  let book
  try {
    book = await new EPUB({ loadText, loadBlob, getSize }).init()
    trace('EPUB.init OK, sections=', book.sections?.length, 'toc=', (book.toc || []).length)
  } catch (e) {
    trace('EPUB.init FAILED', e?.message || e)
    showError(
      'Malformed or unsupported EPUB',
      `${e?.message || e}\nfilename: ${filename}\nbase: ${baseUrl}`,
    )
    return
  }

  setStatus('Rendering…')
  trace('view element', view, 'tagName=', view.tagName, 'isConnected=', view.isConnected)

  // ──────────────────────────────────────────────────────────────────
  // Documented foliate-js init sequence (per upstream reader.js):
  //   1. await view.open(book)
  //   2. attach 'load' / 'relocate' listeners
  //   3. view.renderer.setStyles(css)            ← styles BEFORE first paint
  //   4. view.renderer.next()  OR  view.goTo(savedCfi)
  // We were doing it backwards (listeners pre-open, navigate before
  // setStyles), which forced the paginator to lay out on a freshly
  // styled doc immediately afterwards — every reflow then hit
  // half-attached docs and threw. Following the canonical order
  // is the structural fix that obviates the need for the SPINE-PATCH
  // null guards (left in as defense-in-depth).
  // ──────────────────────────────────────────────────────────────────

  trace('about to await view.open(book)')
  try {
    await view.open(book)
    trace('view.open OK; renderer=', view.renderer?.constructor?.name)
    trace('host clientWidth/height=', view.clientWidth, '/', view.clientHeight)
    // SPINE-PATCH 0.4.2: override foliate's desktop-reader defaults
    // for phone-portrait layout. Halve the page-to-page gap from
    // 7% → 3%. `max-inline-size` and `margin` are owned by
    // applyReaderTheme (driven by the prefs slider); it runs right
    // after open, so we don't seed values here. `max-block-size`
    // defaults to 1440px (a desktop reading constraint); on a phone
    // with WebView height ~2000px+ that caps the column block and
    // centers it vertically, leaving a big empty band above the
    // text. Override to fill the available height.
    try {
      view.renderer?.setAttribute?.('gap', '3%')
      view.renderer?.setAttribute?.('max-block-size', '9999px')
    } catch (e) {
      console.warn('foliate layout overrides threw', e?.message || e)
    }
  } catch (e) {
    trace('view.open FAILED', e?.message || e, '\n', e?.stack || '')
    showError(
      'Reader failed to open book',
      `${e?.message || e}\nfilename: ${filename}`,
    )
    return
  }

  // Step 2 — listeners after open per foliate's reader.js
  view.addEventListener('load', e => {
    const { doc, index } = e.detail || {}
    trace('view event: load index=', index, 'doc=', !!doc)
    currentSectionIndex = index
    if (doc) attachToDoc(doc, index)
  })
  view.addEventListener('relocate', e => {
    const detail = e.detail || {}
    trace('view event: relocate cfi=', detail.cfi, 'tocLabel=', detail.tocItem?.label)
    const cfi = detail.cfi || null
    // SPINE-PATCH 0.3.26 (N3.5): publish a complete `location`
    // payload so SessionPanel can render percentage / chapter
    // position without a second round-trip. Foliate's relocate
    // detail exposes 0..1 progress under either `fraction` (newer
    // bundles) or `percentage` (older). Fall back to null when both
    // are absent so Kotlin can decide whether to suppress the % row.
    let progress = null
    if (typeof detail.fraction === 'number') progress = detail.fraction
    else if (typeof detail.percentage === 'number') progress = detail.percentage
    if (cfi) publishLocator({
      engine: 'foliate',
      schema: 'epubcfi',
      locator: cfi,
      percentage: progress,
      sectionLabel: detail.tocItem?.label || null,
      sectionIndex: typeof detail.index === 'number' ? detail.index : null,
      totalSections: book?.sections?.length ?? null,
    })
    // Re-arm SessionTimer on every relocate. A relocate fires for
    // every page-turn, every chapter-jump, every scrubber commit —
    // exactly the events that prove the user is still reading.
    try { window.SpineBridge?.notePageEvent?.() } catch (_) {}
  })
  view.addEventListener('draw-annotation', e => {
    const { draw, annotation } = e.detail
    const colour = annotation?.color || '#f6c343'
    draw(Overlayer.highlight, { color: colour })
  })
  view.addEventListener('show-annotation', e => {
    const { value } = e.detail || {}
    try {
      if (window.SpineBridge && typeof window.SpineBridge.onAnnotationTap === 'function') {
        window.SpineBridge.onAnnotationTap(value || '')
      }
    } catch (_) {}
  })
  for (const evtName of ['error', 'open', 'rendition', 'rendered']) {
    view.addEventListener(evtName, e => {
      trace('view event:', evtName, e?.detail || '')
    })
  }

  // Step 3 — styles BEFORE first paint so the renderer's columnize
  // measures against the final font-size/line-height/etc.
  try {
    window.spineHost.applyReaderTheme()
    trace('initial setStyles applied')
  } catch (e) {
    trace('applyReaderTheme initial failed', e?.message || e)
  }

  // Step 4 — first render. Saved CFI takes precedence; otherwise
  // call renderer.next() like the canonical demo (paginates from
  // section index 0 without going through the view-layer goTo
  // that requires a Resolved navigation target).
  try {
    const startLocator = (typeof bridge.getStartLocator === 'function')
      ? bridge.getStartLocator()
      : null
    if (startLocator && startLocator !== 'null' && startLocator.length > 0) {
      trace('initial render: goTo saved locator', startLocator)
      await view.goTo(startLocator)
    } else {
      trace('initial render: renderer.next()')
      await view.renderer.next()
    }
  } catch (e) {
    trace('initial render failed', e?.message || e)
    // Last-ditch fallback — if renderer.next throws, try goTo(0)
    try { await view.goTo(0) } catch (e2) {
      showError('Reader could not render', `${e?.message || e}\n${e2?.message || e2}\nfilename: ${filename}`)
      return
    }
  }
  trace('initial navigation complete')

  // Publish a flat TOC to Kotlin for the bottom-bar TOC sheet.
  try {
    const flat = []
    const walk = (nodes, depth) => {
      if (!nodes) return
      for (const n of nodes) {
        if (n?.label && n?.href) flat.push({ label: n.label, href: n.href, depth })
        if (n?.subitems?.length) walk(n.subitems, depth + 1)
      }
    }
    walk(book.toc || [], 0)
    if (window.SpineBridge && typeof window.SpineBridge.publishToc === 'function') {
      window.SpineBridge.publishToc(JSON.stringify(flat))
      trace('TOC published with', flat.length, 'entries')
    }
  } catch (e) {
    trace('publishToc failed', e?.message || e)
  }

  // SPINE-PATCH 0.3.26 (N3.5): publish EPUB <dc:subject> entries as
  // tags. Foliate normalises metadata under `book.metadata.subject`
  // — sometimes a string, sometimes an array of strings, sometimes
  // an array of objects with a `name` field. Coerce to a deduped
  // string list. Empty list is published explicitly so Kotlin can
  // overwrite any prior cached tags (e.g. user re-imported the
  // same book with different metadata).
  try {
    const raw = book?.metadata?.subject
    const tags = []
    const seen = new Set()
    const push = (v) => {
      if (typeof v !== 'string') return
      const t = v.trim()
      if (!t || seen.has(t)) return
      seen.add(t)
      tags.push(t)
    }
    if (Array.isArray(raw)) {
      for (const x of raw) {
        if (typeof x === 'string') push(x)
        else if (x && typeof x.name === 'string') push(x.name)
      }
    } else if (typeof raw === 'string') {
      push(raw)
    }
    if (window.SpineBridge && typeof window.SpineBridge.publishTags === 'function') {
      window.SpineBridge.publishTags(JSON.stringify(tags))
      trace('tags published:', tags.length, tags.slice(0, 4))
    }
  } catch (e) {
    trace('publishTags failed', e?.message || e)
  }

  // Pull the persisted highlights for this book and render them.
  // Kotlin pushes JSON via window.spineHost.applyHighlights so
  // there's only one bridge direction (Kotlin → JS via
  // evaluateJavascript). The first sync is requested here via
  // SpineBridge.requestHighlights so the activity can fire-and-
  // forget the load.
  try {
    if (window.SpineBridge && typeof window.SpineBridge.requestHighlights === 'function') {
      window.SpineBridge.requestHighlights()
    }
  } catch (_) {}

  setStatus(null)
}

// Public surface that Kotlin can drive via webView.evaluateJavascript.
window.spineHost = {
  /** Apply a list of {locator, color} highlights. Existing
   *  highlights for the book are wiped and re-added, so this is the
   *  one and only source of truth — pushing an empty list deletes
   *  every visible highlight. */
  applyHighlights(jsonString) {
    let list = []
    try { list = JSON.parse(jsonString || '[]') } catch (_) {}
    // Foliate's view tracks annotations by `value` (the CFI string).
    // Remove anything currently drawn that isn't in the new list,
    // then add (or update) the rest.
    const incoming = new Set(list.map(h => h.locator))
    if (window.__spineDrawnHighlights) {
      for (const cfi of window.__spineDrawnHighlights) {
        if (!incoming.has(cfi)) {
          try { view.deleteAnnotation({ value: cfi }) } catch (_) {}
        }
      }
    }
    window.__spineDrawnHighlights = incoming
    for (const h of list) {
      try {
        view.addAnnotation({ value: h.locator, color: h.color || '#f6c343' })
      } catch (e) {
        console.warn('addAnnotation failed', h.locator, e)
      }
    }
  },
  /** Jump the reader to a given locator (highlight or bookmark
   *  tap from the AnnotationsSheet). */
  goTo(locator) {
    try { view.goTo(locator) } catch (_) {}
  },
  /** Jump to a TOC entry's href (Kotlin TOC sheet). */
  goToHref(href) {
    try { view.goTo(href) } catch (e) { console.warn('goToHref', href, e?.message || e) }
  },
  /** Move forward one page (Kotlin bottom-bar arrow). Routes
   *  through the same buffered turn queue as the tap-zone
   *  router so spam-tapping the prev/next buttons across a
   *  chapter boundary doesn't wedge on foliate's #locked. */
  pageNext() {
    requestTurn(1)
  },
  /** Move back one page (Kotlin bottom-bar arrow). */
  pagePrev() {
    requestTurn(-1)
  },
  /**
   * Seek to a 0..1 fraction of the book. Used by the N5 chapter
   * scrubber: drag releases commit a target fraction here. Tries
   * foliate's `view.goToFraction` first; falls back to a spine-
   * index-based jump that picks the section whose cumulative
   * length crosses the target — coarse but always available.
   * Out-of-range inputs are clamped to [0, 1]. (Sprint N3.5.)
   */
  seek(fraction) {
    let p = Number(fraction)
    if (!Number.isFinite(p)) return
    if (p < 0) p = 0
    if (p > 1) p = 1
    try {
      if (typeof view?.goToFraction === 'function') {
        view.goToFraction(p)
        return
      }
    } catch (e) {
      console.warn('seek: goToFraction threw, falling back', e?.message || e)
    }
    // Fallback: pick the section index covering this fraction.
    // The spine-index seek is coarse (one chunk granularity) but
    // works on any foliate build.
    try {
      const sections = view?.book?.sections || []
      if (!sections.length) return
      const idx = Math.min(sections.length - 1, Math.floor(p * sections.length))
      view.goTo(idx)
    } catch (e) {
      console.warn('seek: spine-index fallback threw', e?.message || e)
    }
  },
  /**
   * Pull the current reader theme colors from Kotlin and push them
   * into the active spine-item iframes via foliate's setStyles. The
   * paginator stores two style elements per spine doc (a "before"
   * sheet for normalising, a "main" sheet for theming); setStyles
   * writes the main sheet, which is exactly the user-theme slot.
   * Called once on init after view.open, and again from Kotlin
   * every time the user picks a new theme in Settings.
   */
  applyReaderTheme() {
    let json = '{}'
    try {
      if (window.SpineBridge && typeof window.SpineBridge.getReaderThemeJson === 'function') {
        json = window.SpineBridge.getReaderThemeJson() || '{}'
      }
    } catch (e) {
      console.warn('applyReaderTheme: getReaderThemeJson threw', e?.message || e)
      return
    }
    let t
    try { t = JSON.parse(json) } catch (_) { return }
    const fontSize = parseInt(t.fontSizePx || '18', 10)
    const lineHeight = parseFloat(t.lineHeight || '1.5')
    const fontFamily = t.fontFamily || "Georgia, 'Times New Roman', Times, serif"
    // SPINE-PATCH 0.3.26 (N3.5): reader-formatting toggles. Each
    // flag is a discrete CSS rule appended to the main sheet. When
    // off, the rule is omitted entirely (cheaper than overriding
    // with `text-align: initial`). proto312 default for all three
    // is true.
    const justify = t.justify === true || t.justify === 'true'
    const hyphenate = t.hyphenate === true || t.hyphenate === 'true'
    const dropCap = t.dropCap === true || t.dropCap === 'true'
    // SPINE-PATCH 0.4.2: drive horizontal page margin via foliate's
    // `max-inline-size` attribute. Foliate's `margin` is BLOCK-axis
    // (top/bottom) on horizontal-tb writing, NOT inline. The inline
    // gutter comes from the leftover space between viewport width
    // and the column's max-inline-size — a smaller cap = wider
    // gutters. column_w = viewport * (1 - 2*marginPct), then foliate
    // letterboxes the rest equally on each side. This lives inside
    // the iframe so the page-turn animation slides the entire margin
    // with the column (Compose-side padding clipped the column at
    // the gutter pre-0.4.2). Block-axis margin stays 0px (set at
    // open) so chapter headers don't dominate the first page.
    const marginPct = parseFloat(t.marginPct)
    const inlinePct = Number.isFinite(marginPct)
      ? Math.max(0, Math.min(0.5, marginPct))
      : 0
    const maxInline = `${((1 - 2 * inlinePct) * 100).toFixed(2)}%`
    try {
      view.renderer?.setAttribute?.('max-inline-size', maxInline)
      // Re-assert block-axis margin to a small value — applyReaderTheme
      // is the single source of truth for layout from now on, and
      // a stale value from a previous theme apply could otherwise
      // linger. 0px keeps chapter h1's flush to the top of the page.
      view.renderer?.setAttribute?.('margin', '0px')
    } catch (e) {
      console.warn('applyReaderTheme: layout setAttribute threw', e?.message || e)
    }
    // NB: do NOT set padding on <body> here — foliate's paginator
    // sets padding on <html> as part of its columnize math, and an
    // overlap of body padding crushes column-width down to one
    // character (lol bug from 0.3.1). Inline gutter is owned by
    // foliate's `max-inline-size` attribute (set just above); this
    // CSS only owns colors, font, and line-height.
    const css = `
      html, body {
        background: ${t.bg} !important;
        color: ${t.ink} !important;
        font-family: ${fontFamily} !important;
        font-size: ${fontSize}px !important;
        line-height: ${lineHeight} !important;
        margin-top: 0 !important;
        padding-top: 0 !important;
      }
      /* EPUB stylesheets put margin/padding-top on h1/h2/section/
       * body wrappers — Spine pads device-side already, so any
       * EPUB-added top margin reads as "text way too low". Strip
       * the top margin/padding of EVERY leading element in the
       * page-rendering chain. The cascade catches:
       *   - body's own top margin/padding
       *   - body's first child (often a div / section / article)
       *   - that first child's first child (the actual h1)
       *   - any h1/h2/h3 that's the first thing on a page
       * Later headings retain their natural top margin.
       */
      body { margin-top: 0 !important; padding-top: 0 !important; }
      body > *:first-child,
      body > *:first-child > *:first-child,
      body > *:first-child > *:first-child > *:first-child {
        margin-top: 0 !important;
        padding-top: 0 !important;
      }
      h1:first-child, h2:first-child, h3:first-child,
      h4:first-child, h5:first-child, h6:first-child {
        margin-top: 0 !important;
        padding-top: 0 !important;
      }
      p, div, li, blockquote { line-height: inherit !important; }
      a, a:visited { color: ${t.link || t.ink} !important; }
      hr { border-color: ${t.rule || t.dim} !important; }
      blockquote { color: ${t.dim || t.ink} !important; }
      ::selection { background: ${t.dim || t.ink}; color: ${t.bg}; }
      ${justify ? 'p { text-align: justify !important; text-justify: inter-word; }' : ''}
      ${hyphenate ? 'p { hyphens: auto !important; -webkit-hyphens: auto !important; -ms-hyphens: auto !important; }' : ''}
      ${dropCap ? `
        section > p:first-of-type::first-letter,
        body > p:first-of-type::first-letter {
          font-size: 3.2em;
          line-height: 0.95;
          float: left;
          padding: 0.05em 0.08em 0 0;
          font-weight: 600;
        }
      ` : ''}
    `
    try {
      view.renderer?.setStyles?.(css)
    } catch (e) {
      console.warn('applyReaderTheme: setStyles threw', e?.message || e)
    }
  },
  /** Clear the current selection (e.g. after the user has chosen
   *  Highlight from the SelectionBar — the selection range no
   *  longer needs to remain visually selected). */
  clearSelection() {
    try {
      const docs = view.renderer?.getContents?.() || []
      for (const c of docs) {
        try { c.doc?.defaultView?.getSelection?.()?.removeAllRanges?.() } catch (_) {}
      }
    } catch (_) {}
    publishSelection(null)
  },
}

// Surface uncaught errors to the visible UI rather than burying them
// in the WebView's console (which a real-device user can't see
// without a developer tether). The benign-warning filter is critical:
// Chrome reports "ResizeObserver loop completed with undelivered
// notifications" as an `error` event even though the spec says it's
// a warning, and foliate's paginator triggers this every layout
// pass — without this filter every page-turn flashes a fatal-looking
// error overlay.
const BENIGN_ERROR_PATTERNS = [
  /ResizeObserver loop/i,
  /Non-Error promise rejection captured/i,
  // SPINE-PATCH: foliate's paginator/view/cfi pipeline fires from a
  // ResizeObserver and from tap handlers that race the iframe srcdoc
  // attach. The page renders fine afterwards; the banner just makes
  // every page-turn look catastrophic. Suppress the visible overlay
  // for these specific null-deref signatures originating in the
  // foliate-vendored modules. They still print to console for
  // logcat-side diagnosis.
  /Cannot read properties of null \(reading '(childNodes|querySelectorAll|getBoundingClientRect|addEventListener|body|documentElement|element|style|defaultView|getSelection)'\)/i,
  /Cannot destructure property '\w+' of 'undefined'/i,
  /Failed to execute 'createTreeWalker' on 'Document'/i,
  /Failed to execute 'removeChild' on 'Node'/i,
  /The node to be removed is not a child of this node/i,
]
function isBenignError(msg) {
  if (!msg) return false
  return BENIGN_ERROR_PATTERNS.some(rx => rx.test(msg))
}
window.addEventListener('error', ev => {
  if (isBenignError(ev?.message)) {
    console.warn('[spine-host] benign error suppressed:', ev.message)
    ev.preventDefault?.()
    return
  }
  if (errorEl.hidden) {
    showError('Unexpected error', `${ev.message}\nat ${ev.filename}:${ev.lineno}:${ev.colno}`)
  }
})
window.addEventListener('unhandledrejection', ev => {
  // SPINE-PATCH 0.3.22: never paint the in-WebView red banner for
  // unhandled promise rejections. Foliate's load/render pipeline emits
  // these from cancelled fetches, srcdoc-load timeouts, and observer
  // re-fires during chrome toggles — none of them actually break
  // rendering, but the banner makes them look catastrophic. Always
  // log to console so logcat-side diagnosis still works.
  const msg = ev?.reason?.message || ev?.reason || ''
  console.warn('[spine-host] unhandled rejection (suppressed):', msg)
  ev.preventDefault?.()
})

main().catch(e => {
  trace('main() rejected', e?.message || e, '\n', e?.stack || '')
  showError('Fatal', `${e?.message || e}\n${e?.stack || ''}`)
})
