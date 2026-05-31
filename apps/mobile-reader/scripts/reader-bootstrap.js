// Reader-side bootstrap. Runs inside the WebView. Talks to RN via
// window.ReactNativeWebView.postMessage. Receives commands from RN as messages
// dispatched through window.SpineReader.handle (called by RN's
// injectJavaScript with a JSON envelope).
//
// Message shapes — all JSON envelopes:
//   from RN:
//     { type: "open", base64: "<EPUB bytes as base64>", settings: { ... } }
//     { type: "settings", settings: { ... } }
//     { type: "next" } | { type: "prev" }
//     { type: "goto", target: "<href|cfi>" }
//   to RN:
//     { type: "ready" }
//     { type: "rendered" }
//     { type: "location", cfi, href, percentage, page, totalPages }
//     { type: "error", message }
//     { type: "tap", zone: "left"|"center"|"right" }

(function () {
  "use strict";
  /* global ePub */

  var statusEl = document.getElementById("status");
  var viewer = document.getElementById("viewer");
  var book = null;
  var rendition = null;
  var MB = 1024 * 1024;
  var LARGE_BOOK_BYTES = 35 * MB;
  var MAX_EAGER_OPEN_BYTES = 120 * MB;

  function post(obj) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    }
  }

  function showStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("show", !!msg);
    statusEl.classList.toggle("error", !!isError);
  }

  // EPUB bytes used to be shipped from RN to the WebView as a base64 string
  // via injectJavaScript. That spiked the JNI heap to ~6× the on-disk size
  // and OOMed for moderately large books. The reader now fetches the file
  // straight from the WebView's file:// origin so the bytes flow disk →
  // ArrayBuffer with no intermediate string copy.
  //
  // fetch() on file:// is unreliable across Android WebView versions —
  // some return "Failed to fetch" with no usable error. XHR with
  // responseType=arraybuffer is the venerable fallback that works
  // everywhere fetch doesn't.
  function fetchAsArrayBuffer(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = function () {
        // file:// XHRs report status 0 on success. Any non-empty response
        // counts as good; otherwise treat as a load failure.
        var ok = (xhr.status >= 200 && xhr.status < 300) || xhr.status === 0;
        if (ok && xhr.response) {
          resolve(xhr.response);
        } else {
          reject(new Error("XHR " + xhr.status + " for " + url));
        }
      };
      xhr.onerror = function () { reject(new Error("XHR failed for " + url)); };
      xhr.send();
    });
  }

  function applySettings(s) {
    if (!s) return;
    var root = document.documentElement;
    if (s.bg) root.style.setProperty("--reader-bg", s.bg);
    if (s.ink) root.style.setProperty("--reader-ink", s.ink);
    if (s.dim) root.style.setProperty("--reader-dim", s.dim);
    if (s.rule) root.style.setProperty("--reader-rule", s.rule);
    if (s.accent) root.style.setProperty("--reader-accent", s.accent);
    if (s.fontFamily) root.style.setProperty("--reader-font-family", s.fontFamily);
    if (s.fontSize) root.style.setProperty("--reader-font-size", s.fontSize + "pt");
    if (s.lineHeight) root.style.setProperty("--reader-line-height", String(s.lineHeight));

    if (rendition) {
      rendition.themes.override("color", s.ink, true);
      rendition.themes.override("background", s.bg, true);
      var bodyOverrides = {
        "color": s.ink + " !important",
        "background": s.bg + " !important",
        "font-family": s.fontFamily + " !important",
        "line-height": String(s.lineHeight) + " !important",
        "text-align": s.justify ? "justify" : "left",
        "-webkit-hyphens": s.hyphenate ? "auto" : "manual",
        "hyphens": s.hyphenate ? "auto" : "manual",
      };
      var paragraphOverrides = {
        "color": s.ink + " !important",
        "font-family": s.fontFamily + " !important",
        "line-height": String(s.lineHeight) + " !important",
        "text-align": s.justify ? "justify" : "left",
      };
      rendition.themes.register("spine", {
        "html, body": bodyOverrides,
        "p, div, span, li": paragraphOverrides,
        "a": { color: s.accent + " !important" },
        // Highlight color classes — applied by epubjs's annotations API
        // (see applyHighlights). Five colors mirror the SelectionBar +
        // store schema. Wash alpha is 0.42 — visible on every theme,
        // doesn't drown the ink.
        ".spine-hl-yellow": { "background-color": "rgba(245,215,97,0.42) !important" },
        ".spine-hl-pink":   { "background-color": "rgba(232,155,182,0.42) !important" },
        ".spine-hl-green":  { "background-color": "rgba(155,200,138,0.42) !important" },
        ".spine-hl-blue":   { "background-color": "rgba(154,186,216,0.42) !important" },
        ".spine-hl-orange": { "background-color": "rgba(232,167,102,0.42) !important" },
        "h1, h2, h3, h4, h5, h6": {
          "color": s.ink + " !important",
          "font-family": s.fontFamily + " !important",
        },
        // Cover-style pages: many EPUBs ship the first chapter as a single
        // <svg> or <img> filling the body. Without these rules epubjs's
        // default CSS leaves them top-left aligned and oversized.
        "body > svg:only-child, body > img:only-child, body > div:only-child > svg:only-child, body > div:only-child > img:only-child":
          {
            "display": "block",
            "max-width": "100%",
            "max-height": "100%",
            "width": "auto",
            "height": "auto",
            "margin": "auto",
            "object-fit": "contain",
          },
        "img": {
          "max-width": "100% !important",
          "max-height": "100% !important",
          "height": "auto !important",
        },
        "svg": {
          "max-width": "100% !important",
          "max-height": "100% !important",
        },
        // First-letter drop-cap: epub spec is fragile across books, so we
        // target the first paragraph after a chapter heading.
        "h1 + p::first-letter, h2 + p::first-letter, body > p:first-of-type::first-letter": s.dropCap
          ? {
              "float": "left",
              "font-size": "3.4em",
              "line-height": "0.85",
              "padding-right": "0.08em",
              "padding-top": "0.05em",
              "font-weight": "600",
              "font-style": "italic",
              "color": s.accent + " !important",
              "font-family": s.fontFamily + " !important",
            }
          : { "float": "none", "font-size": "inherit" },
      });
      rendition.themes.select("spine");
      rendition.themes.fontSize(s.fontSize + "pt");
    }
  }


  function setupTapZones() {
    // No-op. The reader's tap/swipe gestures are owned by an RN
    // PanResponder overlay on top of the WebView — see the gesture
    // overlay in app/reader/[id].tsx. Letting the bootstrap also post
    // taps would double-fire any gesture that propagated through the
    // WebView's native touch handling alongside the RN responder.
  }

  // Shared per-iframe context for the selection / long-press handlers.
  // contents.document is what the user actually touches; contents.cfiFromRange
  // is what we need to anchor a highlight. Stored on a WeakMap keyed by
  // the iframe's contentWindow so a relocated() callback can find the
  // right document without globals.
  var iframeContexts = new WeakMap();

  function attachIframeTapHandler(contents) {
    // 0.3.0 turns text selection back ON inside the iframe so the
    // user can highlight, copy, look up, and share. Tap/swipe handling
    // still belongs to the RN PanResponder overlay (app/reader/[id].tsx)
    // — only DRAG-SELECT and LONG-PRESS originate here. See the
    // big comment in [id].tsx about onPanResponderTerminationRequest;
    // when this code posts {type:"selection"} the RN side flips a flag
    // that releases the responder so the WebView can extend a selection
    // without the page-turn handler stealing the gesture.
    try {
      var doc = contents.document;
      var html = doc.documentElement;
      html.style.webkitUserSelect = "text";
      html.style.userSelect = "text";
      // Suppress the iOS callout menu — we render our own RN floating bar.
      // (Android's ActionMode still fires; the system bar appears briefly
      // and our bar floats above it. Replacing Android's ActionMode
      // wholesale needs a native view override out of scope for 0.3.0.)
      html.style.webkitTouchCallout = "none";
    } catch (_) {
      /* swallow */
    }

    iframeContexts.set(contents.window, contents);

    // Selection. Coalesce "selectionchange" events — Android fires one
    // per character of drag and we'd flood the JSI bridge.
    var selectionTimer = null;
    var lastPostedSelection = "";
    var lastPostedRange = "";

    function postSelection() {
      selectionTimer = null;
      try {
        var sel = contents.window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          if (lastPostedSelection !== "") {
            lastPostedSelection = "";
            lastPostedRange = "";
            post({ type: "selectionEnd" });
          }
          return;
        }
        var range = sel.getRangeAt(0);
        var text = sel.toString();
        if (!text || text.trim().length === 0) return;

        // Design spec: "Cap selection at 2,000 chars; refuse cross-chapter
        // selections entirely (epubjs CFI ranges across spine items
        // are unreliable)." Cross-chapter is detected by RN since it
        // knows the spine; we defend against runaway length here.
        if (text.length > 2000) {
          // Truncate the SELECTION VISUALLY too — without this the
          // user sees their highlight drag past the cap with no
          // feedback.
          try {
            var truncRange = range.cloneRange();
            // Walk back to char 2000. Best-effort; if range is across
            // multiple text nodes, just dedupe the post.
            text = text.slice(0, 2000);
          } catch (_) {
            /* swallow */
          }
        }

        var cfiRange = "";
        try {
          cfiRange = contents.cfiFromRange(range);
        } catch (_) {
          /* if epubjs can't anchor, we can't highlight — but we can
             still copy/look-up. Empty string signals "no anchor". */
        }

        // Snippet anchors. 64 chars on each side is enough to
        // disambiguate within a chapter without bloating storage.
        var before = "";
        var after = "";
        try {
          var node = range.startContainer;
          if (node && node.nodeType === Node.TEXT_NODE) {
            before = node.data.slice(Math.max(0, range.startOffset - 64), range.startOffset);
          }
          var endNode = range.endContainer;
          if (endNode && endNode.nodeType === Node.TEXT_NODE) {
            after = endNode.data.slice(range.endOffset, range.endOffset + 64);
          }
        } catch (_) {
          /* leave snippets empty; re-anchor will only have text to go on */
        }

        var rect = null;
        try {
          var rects = range.getClientRects();
          if (rects && rects.length > 0) {
            // Use the LAST rect's top — selection bar floats above the
            // bottom of the selection so a multi-line drag doesn't
            // cover the user's last word.
            var first = rects[0];
            var last = rects[rects.length - 1];
            rect = {
              left: first.left,
              top: first.top,
              right: last.right,
              bottom: last.bottom,
              width: last.right - first.left,
              height: last.bottom - first.top,
            };
          }
        } catch (_) {
          /* swallow */
        }

        // Dedupe: same text + same cfiRange = same selection event
        // re-fired by the platform. Don't repost.
        if (text === lastPostedSelection && cfiRange === lastPostedRange) return;
        lastPostedSelection = text;
        lastPostedRange = cfiRange;

        post({
          type: "selection",
          text: text,
          cfiRange: cfiRange,
          textBefore: before,
          textAfter: after,
          rect: rect,
        });
      } catch (e) {
        post({ type: "error", message: "selection: " + (e && e.message ? e.message : String(e)) });
      }
    }

    function onSelectionChange() {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(postSelection, 60);
    }

    try {
      doc.addEventListener("selectionchange", onSelectionChange, { passive: true });
    } catch (_) {
      /* swallow */
    }

    // Tap + swipe detection. Long-press is delegated to Android's
    // NATIVE WebView gesture detector now — that's the only way to
    // surface the system selection handles. The bootstrap's
    // selectionchange listener (above) catches whatever selection
    // Android creates and posts it to RN.
    //
    // Tap = brief single-finger touch with <8px movement.
    // Swipe = horizontal drag > 30px with |dx| > |dy| * 1.5.
    var TAP_TOL = 8;
    var SWIPE_DIST = 30;
    var TAP_MAX_MS = 350;
    var touchStart = null;
    var swipeFired = false;

    function onTouchStart(e) {
      if (!e.touches || e.touches.length !== 1) {
        touchStart = null;
        swipeFired = false;
        return;
      }
      var t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
      swipeFired = false;
    }

    function onTouchMove(e) {
      if (!touchStart || swipeFired) return;
      if (!e.touches || e.touches.length !== 1) {
        touchStart = null;
        return;
      }
      var t = e.touches[0];
      var dx = t.clientX - touchStart.x;
      var dy = t.clientY - touchStart.y;
      // Horizontal swipe → page-turn. Fire ONCE per gesture; the
      // user's finger may continue past the threshold but we don't
      // re-fire.
      if (Math.abs(dx) > SWIPE_DIST && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swipeFired = true;
        post({ type: "swipe", dir: dx > 0 ? "prev" : "next" });
      }
    }

    function onTouchEnd(e) {
      var start = touchStart;
      touchStart = null;
      var wasSwipe = swipeFired;
      swipeFired = false;
      if (!start || wasSwipe) return;
      // Tap detection: short duration + minimal movement. If the
      // user held long enough for Android to engage selection,
      // there's no tap fired — they get a selection instead.
      try {
        var t = (e.changedTouches && e.changedTouches[0]) || null;
        if (!t) return;
        var dx = t.clientX - start.x;
        var dy = t.clientY - start.y;
        var dur = Date.now() - start.at;
        if (
          dur < TAP_MAX_MS &&
          Math.abs(dx) < TAP_TOL &&
          Math.abs(dy) < TAP_TOL
        ) {
          // Convert iframe-local (clientX/Y) to screen-relative by
          // adding the iframe's bounding rect offset relative to
          // the outer document.
          var iframe = (function () {
            var all = document.querySelectorAll("iframe");
            for (var i = 0; i < all.length; i++) {
              if (all[i].contentWindow === contents.window) return all[i];
            }
            return null;
          })();
          if (!iframe) return;
          var rect = iframe.getBoundingClientRect();
          post({
            type: "tap",
            x: rect.left + t.clientX,
            y: rect.top + t.clientY,
          });
        }
      } catch (_) { /* swallow */ }
    }

    try {
      doc.addEventListener("touchstart", onTouchStart, { passive: true });
      doc.addEventListener("touchmove", onTouchMove, { passive: true });
      doc.addEventListener("touchend", onTouchEnd, { passive: true });
      doc.addEventListener("touchcancel", function () { touchStart = null; swipeFired = false; }, { passive: true });
    } catch (_) {
      /* swallow */
    }
  }

  // Resolve the word under (x, y) inside doc. Returns { text, range }
  // or null if the point is outside any text node. Uses
  // caretRangeFromPoint (Chrome/WebView) with a fallback to
  // caretPositionFromPoint (spec). The returned range covers the whole
  // word, snapped on \W boundaries.
  function wordAtPoint(doc, x, y) {
    var caret = null;
    if (doc.caretRangeFromPoint) {
      caret = doc.caretRangeFromPoint(x, y);
      if (!caret) return null;
      var node = caret.startContainer;
      var offset = caret.startOffset;
    } else if (doc.caretPositionFromPoint) {
      var pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      node = pos.offsetNode;
      offset = pos.offset;
    } else {
      return null;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    var text = node.data;
    if (!text) return null;
    // Walk left + right to the word boundary. \w includes underscore;
    // good enough for the alpha. Hyphenated words ("self-respect") split
    // into two — fine, dictionary lookup will at worst hit "self".
    var left = offset;
    while (left > 0 && /\w/.test(text.charAt(left - 1))) left--;
    var right = offset;
    while (right < text.length && /\w/.test(text.charAt(right))) right++;
    if (left === right) return null;
    var range = doc.createRange();
    range.setStart(node, left);
    range.setEnd(node, right);
    return { text: text.slice(left, right), range: range };
  }

  // Center cover-style sections. epubjs's column-based body layout breaks
  // plain CSS centering — a block child with width:auto fills the column,
  // and SVGs without an intrinsic height ignore translate(-50%) since
  // they have no measured height to translate against.
  //
  // Solution: detect single-svg/img bodies, override epubjs's inline column
  // styles with `display: flex; column-width: auto`, and let flex centering
  // do the work. The flex container's height is set to the iframe viewport
  // so the child centers within the visible page rather than within the
  // (potentially shorter) column.
  function centerCoverIfPresent(contents) {
    try {
      var doc = contents.document;
      var body = doc.body;
      var html = doc.documentElement;
      if (!body) return;
      var elementChildren = [];
      for (var i = 0; i < body.children.length; i++) {
        var n = body.children[i];
        if (n.nodeType === 1) elementChildren.push(n);
      }
      if (elementChildren.length !== 1) return;
      var only = elementChildren[0];
      // Unwrap a single wrapper div if it contains exactly one media child.
      if (only.tagName === "DIV" && only.children && only.children.length === 1) {
        var inner = only.children[0];
        if (inner && (inner.tagName === "SVG" || inner.tagName === "IMG")) {
          only = inner;
        }
      }
      if (only.tagName !== "SVG" && only.tagName !== "IMG") return;

      // Override the cover's hard-coded sizing attrs.
      only.removeAttribute("width");
      only.removeAttribute("height");
      only.style.maxWidth = "100%";
      only.style.maxHeight = "100%";
      only.style.width = "auto";
      only.style.height = "auto";
      only.style.objectFit = "contain";
      only.style.flex = "0 0 auto";

      // Force a proper full-viewport flex container, defeating epubjs's
      // inline column-width / column-fill so the body actually fills the
      // iframe vertically.
      var viewport = window.innerHeight || doc.documentElement.clientHeight;
      html.style.height = "100%";
      body.style.cssText +=
        ";display:flex !important" +
        ";align-items:center !important" +
        ";justify-content:center !important" +
        ";column-width:auto !important" +
        ";column-count:1 !important" +
        ";column-gap:0 !important" +
        ";margin:0 !important" +
        ";padding:0 !important" +
        ";min-height:" + viewport + "px" +
        ";height:" + viewport + "px" +
        ";width:100%";
    } catch (_) {
      /* swallow */
    }
  }

  // openId increments on every open() call so any in-flight async
  // chain from a previous open knows it's stale and aborts before
  // touching the (now overwritten) book / rendition globals. Without
  // this, rapid library-back / library-open cycles could leave the
  // first book's locations.generate.then() landing on the second
  // book's globals.
  var openId = 0;
  var lastReportedCfi = null;

  function open(url, settings, startAt, sizeBytes) {
    openId += 1;
    var myOpenId = openId;
    var knownSize = Number(sizeBytes) || 0;
    if (knownSize > MAX_EAGER_OPEN_BYTES) {
      showStatus(
        "This EPUB is too large for the current reader engine. It imported successfully, but opening it needs the native chapter-streaming reader.",
        true
      );
      post({
        type: "error",
        message: "This EPUB imported, but it is too large for this reader build. Use a smaller EPUB or wait for the native chapter-streaming reader."
      });
      return;
    }
    showStatus("Opening…");
    // Tear down any rendition from the previous book before swapping
    // the global. epubjs's rendition holds DOM, listeners, and an
    // open Book instance — leaking it across rapid re-opens
    // accumulates stale event handlers.
    if (rendition) {
      try { rendition.destroy(); } catch (_) { /* swallow */ }
      rendition = null;
    }
    if (book) {
      try { book.destroy(); } catch (_) { /* swallow */ }
      book = null;
    }
    lastReportedCfi = null;
    fetchAsArrayBuffer(url)
      .then(function (buffer) {
        if (openId !== myOpenId) return; // newer open superseded us
        try {
          book = ePub(buffer);
        } catch (err) {
          showStatus("Failed to decode EPUB: " + (err && err.message), true);
          post({ type: "error", message: String(err && err.message) });
          return;
        }
        finishOpen(settings, startAt, myOpenId);
      })
      .catch(function (err) {
        if (openId !== myOpenId) return;
        showStatus("Could not load file: " + (err && err.message), true);
        post({ type: "error", message: String(err && err.message) });
      });
  }

  function finishOpen(settings, startAt, myOpenId) {
    var flow = settings && settings.mode === "scroll" ? "scrolled-doc" : "paginated";
    // Manager choice:
    //   - paginated → "continuous" so adjacent pages pre-render off-screen
    //     and the RN swipe animation drags real content into view.
    //   - scrolled-doc → "default" because epubjs's continuous manager in
    //     scroll mode mounts every visited section into the DOM as the
    //     user scrolls without virtualisation. On a long book that's an
    //     OOM waiting to happen. Default manager keeps memory bounded.
    var managerName = flow === "paginated" ? "continuous" : "default";
    rendition = book.renderTo(viewer, {
      width: "100%",
      height: "100%",
      flow: flow,
      manager: managerName,
      spread: "none",
      allowScriptedContent: false,
    });

    rendition.hooks.content.register(function (contents) {
      // Selection enable + selection/long-press wiring lives inside
      // attachIframeTapHandler now (0.3.0 turns selection back on for
      // highlights / dictionary). Don't pre-disable user-select here
      // or attachIframeTapHandler will be re-enabling against itself
      // mid-mount.
      attachIframeTapHandler(contents);
      centerCoverIfPresent(contents);
    });

    applySettings(settings);

    rendition.on("rendered", function () {
      post({ type: "rendered" });
    });

      rendition.on("relocated", function (location) {
        if (openId !== myOpenId) return;
        try {
          var cfi = location && location.start ? location.start.cfi : null;
          // Dedupe: with manager:"continuous" epubjs fires relocated
          // for every spread the user crosses, including the off-screen
          // adjacent page. Without this guard the location handler
          // double-counts page turns and writes duplicate progress.
          if (cfi && cfi === lastReportedCfi) return;
          lastReportedCfi = cfi;
          var pct = location && location.start ? location.start.percentage : 0;
          var page =
            location && location.start && typeof location.start.location === "number"
              ? location.start.location + 1
              : null;
          var totalPages =
            book && book.locations && typeof book.locations.total === "number"
              ? book.locations.total
              : null;
          post({
            type: "location",
            cfi: cfi,
            href: location && location.start ? location.start.href : null,
            percentage: pct,
            page: page,
            totalPages: totalPages,
          });
      } catch (e) { /* swallow */ }
    });

    book.ready
      .then(function () {
        if (openId !== myOpenId) return;
        return rendition.display(startAt || undefined);
      })
      .then(function () {
        if (openId !== myOpenId) return;
        showStatus("");
        post({ type: "ready" });
        postToc();
        if (book && book.locations && typeof book.locations.generate === "function") {
          if (knownSize > LARGE_BOOK_BYTES) {
            // Full-book location indexing walks the whole EPUB and can
            // pin large fanfic/anthology books after first render. Skip it:
            // the reader remains usable, just without pace/ETA metrics.
            return;
          }
          try {
            book.locations.generate(1024).then(function () {
              if (openId !== myOpenId) return;
              try {
                var total = (book.locations.length && book.locations.length()) || 0;
                if (typeof total === "number" && total > 0) {
                  post({ type: "metrics", totalChars: total * 1024 });
                }
              } catch (_) { /* swallow */ }
            });
          } catch (_) { /* swallow */ }
        }
      })
      .catch(function (err) {
        showStatus("Failed to render: " + (err && err.message), true);
        post({ type: "error", message: String(err && err.message) });
      });
  }

  function flattenToc(toc) {
    var out = [];
    if (!toc || !toc.length) return out;
    for (var i = 0; i < toc.length; i++) {
      var item = toc[i];
      if (!item) continue;
      var entry = { label: String(item.label || "").trim(), href: String(item.href || "") };
      if (item.subitems && item.subitems.length) {
        entry.subitems = flattenToc(item.subitems);
      }
      if (entry.href) out.push(entry);
    }
    return out;
  }

  function postToc() {
    try {
      var nav = book && book.navigation;
      var items = nav ? flattenToc(nav.toc) : [];
      post({ type: "toc", items: items });
    } catch (_) {
      post({ type: "toc", items: [] });
    }
  }

  function seekToPercentage(pct) {
    if (!rendition || !book) return;
    var clamped = Math.max(0, Math.min(1, Number(pct) || 0));
    try {
      if (book.locations && typeof book.locations.cfiFromPercentage === "function") {
        var cfi = book.locations.cfiFromPercentage(clamped);
        if (cfi) {
          rendition.display(cfi);
          return;
        }
      }
    } catch (_) {
      /* fall through to spine fallback */
    }
    // Fallback: pick a spine item proportional to percentage. Not as smooth
    // as locations.cfiFromPercentage but works before locations.generate
    // has finished.
    try {
      var spineItems = book.spine && book.spine.spineItems ? book.spine.spineItems : [];
      if (spineItems.length) {
        var idx = Math.min(spineItems.length - 1, Math.floor(clamped * spineItems.length));
        var target = spineItems[idx];
        if (target && target.href) rendition.display(target.href);
      }
    } catch (_) {
      /* swallow */
    }
  }

  window.SpineReader = {
    handle: function (raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "open":
          open(msg.url, msg.settings, msg.startAt || null, msg.sizeBytes || null);
          break;
        case "settings":
          applySettings(msg.settings);
          break;
        case "next":
          if (rendition) rendition.next();
          break;
        case "prev":
          if (rendition) rendition.prev();
          break;
        case "goto":
          if (rendition && msg.target) rendition.display(msg.target);
          break;
        case "seek":
          seekToPercentage(msg.percentage);
          break;
        case "clearSelection":
          // Called from RN when the user dismisses the SelectionBar
          // (✕, scrim tap, page turn, AppState background). Without
          // this the visual selection lingers under our floating bar
          // and the next selectionchange event re-shows the bar.
          clearAllSelections();
          break;
        case "copySelection":
          // Find the iframe whose getSelection isn't collapsed and
          // execCommand("copy") inside it. execCommand is deprecated
          // but still works in Android WebView for clipboard writes
          // — it lets us avoid pulling in expo-clipboard for this
          // one operation.
          copyActiveSelection();
          break;
        case "setHighlights":
          // RN sends the FULL highlight set for this book on every
          // change. The bootstrap diffs by id against what's currently
          // attached and adds/removes the delta — re-applying every
          // highlight on every change would flicker the wash overlays.
          applyHighlights(msg.highlights || []);
          break;
        case "requestLongPress":
          // RN's PanResponder detected a long-press at (x, y) screen
          // coords and is asking us to find the word and post a
          // `longpress` event. We do the iframe-walk + wordAtPoint
          // here because the iframe-side touch handler never fires
          // (the responder owns the gesture).
          requestLongPressAt(Number(msg.x) || 0, Number(msg.y) || 0);
          break;
        case "probeHighlightAt":
          probeHighlightAt(Number(msg.x) || 0, Number(msg.y) || 0);
          break;
        case "cheatUp":
          cheatUp(Number(msg.delta) || 0);
          break;
      }
    },
  };

  // RN-driven long-press: the PanResponder owns the gesture, so it
  // tells US where the user held. We find the iframe under that
  // screen point, translate to iframe-doc coords, run wordAtPoint,
  // programmatically select, and post the `longpress` event.
  //
  // Coords are screen-relative as RN measures them. The OUTER WebView
  // document's viewport happens to start at (0, 0) of the WebView's
  // own client area, which RN places below the safe-area inset. RN
  // pre-subtracts the inset before sending so (x, y) here are valid
  // for the outer document's elementFromPoint.
  function requestLongPressAt(x, y) {
    function dbg(m) { post({ type: "debug", message: m }); }
    dbg("LP recv x=" + x.toFixed(0) + " y=" + y.toFixed(0));
    if (!rendition) { dbg("LP no rendition"); return; }
    try {
      // Find the iframe at this point.
      var hit = document.elementFromPoint(x, y);
      dbg("LP elementFromPoint=" + (hit ? hit.tagName : "null"));
      while (hit && hit.tagName !== "IFRAME") {
        hit = hit.parentElement;
      }
      if (!hit) {
        // No iframe under the point. Fall back: enumerate all
        // iframes and pick the first whose bounding rect contains
        // (x, y). Works around outer-doc layouts where epubjs
        // wraps iframes in scroll containers that elementFromPoint
        // returns instead of the iframe itself.
        var all = document.querySelectorAll("iframe");
        dbg("LP no iframe via elementFromPoint, scan " + all.length);
        for (var i = 0; i < all.length; i++) {
          var r = all[i].getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            hit = all[i];
            dbg("LP iframe[" + i + "] hit rect=" + r.left.toFixed(0) + "," + r.top.toFixed(0) + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0));
            break;
          }
        }
        if (!hit) {
          // Log the rects so we can see what coords the iframes ARE at.
          for (var j = 0; j < all.length; j++) {
            var rr = all[j].getBoundingClientRect();
            dbg("LP iframe[" + j + "] rect=" + rr.left.toFixed(0) + "," + rr.top.toFixed(0) + " " + rr.width.toFixed(0) + "x" + rr.height.toFixed(0));
          }
          return;
        }
      }
      var iframe = hit;
      var rect = iframe.getBoundingClientRect();
      // Translate the screen point into iframe-doc coords.
      var ix = x - rect.left;
      var iy = y - rect.top;
      dbg("LP iframe ok ix=" + ix.toFixed(0) + " iy=" + iy.toFixed(0));
      var d = iframe.contentDocument;
      var w = iframe.contentWindow;
      if (!d || !w) { dbg("LP no contentDoc"); return; }
      var word = wordAtPoint(d, ix, iy);
      dbg("LP wordAtPoint=" + (word ? JSON.stringify(word.text) : "null"));
      if (!word) return;
      var range = word.range;
      var cfi = "";
      try {
        var ctx = iframeContexts.get(w);
        if (ctx && typeof ctx.cfiFromRange === "function") {
          cfi = ctx.cfiFromRange(range);
        }
      } catch (_) { /* leave empty cfi */ }
      // Programmatically select so the user sees their target.
      try {
        var sel = w.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) { /* swallow */ }
      var rects = range.getClientRects();
      var rrect = null;
      if (rects && rects.length > 0) {
        var r0 = rects[0];
        rrect = { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom };
      }
      dbg("LP posting longpress");
      post({
        type: "longpress",
        word: word.text,
        cfi: cfi,
        rect: rrect,
      });
    } catch (e) {
      post({ type: "error", message: "requestLongPress: " + (e && e.message ? e.message : String(e)) });
    }
  }

  // Currently-attached highlights, keyed by id. Lets us diff against
  // an incoming set rather than tearing down + re-applying every time
  // the user adds one (which would flicker the entire chapter's
  // washes for a single new entry). Each entry: { color }.
  var attachedHighlights = {};

  function applyHighlights(highlights) {
    if (!rendition || !rendition.annotations) return;
    var incoming = {};
    for (var i = 0; i < highlights.length; i++) {
      var h = highlights[i];
      if (h && h.id && h.cfiRange) incoming[h.id] = h;
    }
    // Remove entries that are gone OR whose color changed.
    for (var id in attachedHighlights) {
      if (!Object.prototype.hasOwnProperty.call(attachedHighlights, id)) continue;
      var old = attachedHighlights[id];
      var inc = incoming[id];
      if (!inc || inc.color !== old.color || inc.cfiRange !== old.cfiRange) {
        try {
          rendition.annotations.remove(old.cfiRange, "highlight");
        } catch (_) { /* annotation already gone — fine */ }
        delete attachedHighlights[id];
      }
    }
    // Add new or color-changed entries. We capture the id in a
    // closure for the click callback AND store it in attachedHighlights
    // so probeHighlightAt can map an SVG hit back to the right id.
    for (var nid in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, nid)) continue;
      if (attachedHighlights[nid]) continue;
      var n = incoming[nid];
      var className = "spine-hl-" + n.color;
      try {
        var ann = rendition.annotations.add(
          "highlight",
          n.cfiRange,
          { id: n.id },
          function (id) {
            return function () {
              post({ type: "highlightTap", id: id });
            };
          }(n.id),
          className,
          // Inline `fill` for the SVG rect epubjs draws — covers
          // the case where the iframe's CSS hasn't loaded the
          // .spine-hl-<color> class yet (race on first render).
          { fill: highlightFillFor(n.color), "fill-opacity": "0.42" },
        );
        attachedHighlights[n.id] = {
          color: n.color,
          cfiRange: n.cfiRange,
          // Held so probeHighlightAt can read annotation.mark.element
          // (or whatever epubjs exposes) for hit-testing. Reference
          // is captured on add; works as long as the rendition
          // itself isn't torn down.
          annotation: ann || null,
        };
      } catch (_) {
        // CFI didn't resolve — likely re-flowed past the spine item
        // or a malformed range. Skip silently; re-anchor is a future
        // pass (P4 stretch goal).
      }
    }
  }

  // RN-driven tap: "is there a highlight at (x, y)?" — the iframe's
  // own click handler can't fire because the gesture overlay walls
  // off touches. We replicate it here: walk the iframe DOM at the
  // touch point looking for an element with className `spine-hl-*`,
  // then map the rendered element back to a highlight id by walking
  // attachedHighlights. On hit, post the same `highlightTap` event
  // the iframe would have posted itself.
  function probeHighlightAt(x, y) {
    if (!rendition) return;
    try {
      var hit = document.elementFromPoint(x, y);
      while (hit && hit.tagName !== "IFRAME") {
        hit = hit.parentElement;
      }
      if (!hit) {
        var all = document.querySelectorAll("iframe");
        for (var i = 0; i < all.length; i++) {
          var r = all[i].getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            hit = all[i];
            break;
          }
        }
        if (!hit) return;
      }
      var iframe = hit;
      var rect = iframe.getBoundingClientRect();
      var ix = x - rect.left;
      var iy = y - rect.top;
      var d = iframe.contentDocument;
      if (!d) return;
      var el = d.elementFromPoint(ix, iy);
      // Walk up looking for a className that contains spine-hl-.
      // SVG's className is an SVGAnimatedString; HTML's is a string.
      // baseVal handles SVG; the `String(...)` falls back to whatever
      // toString gives (the empty string for nodes without a class).
      function classOf(node) {
        if (!node || !node.className) return "";
        return typeof node.className === "string"
          ? node.className
          : (node.className.baseVal || "");
      }
      var marker = el;
      while (marker && marker !== d.body) {
        if (classOf(marker).indexOf("spine-hl-") >= 0) break;
        marker = marker.parentNode;
      }
      if (!marker || marker === d.body) return;
      // Identify the id. Try matching against each attached
      // highlight's annotation element. epubjs exposes the rendered
      // mark via .mark.element on most versions; .element on others.
      // If neither works, fall back to the first attached highlight
      // whose color matches the className parsed from the marker.
      var foundId = null;
      var markerClass = classOf(marker);
      var markerColor = (markerClass.match(/spine-hl-(\w+)/) || [])[1] || "";
      for (var hid in attachedHighlights) {
        if (!Object.prototype.hasOwnProperty.call(attachedHighlights, hid)) continue;
        var entry = attachedHighlights[hid];
        var a = entry.annotation;
        var aEl = (a && a.mark && a.mark.element) || (a && a.element) || null;
        if (aEl && (aEl === marker || aEl.contains(marker) || marker.contains(aEl))) {
          foundId = hid;
          break;
        }
      }
      if (!foundId && markerColor) {
        // Fall back: any attached highlight with the same color.
        // Imperfect when multiple same-color highlights overlap on
        // one page, but at least surfaces SOMETHING the user can
        // act on.
        for (var hid2 in attachedHighlights) {
          if (!Object.prototype.hasOwnProperty.call(attachedHighlights, hid2)) continue;
          if (attachedHighlights[hid2].color === markerColor) {
            foundId = hid2;
            break;
          }
        }
      }
      if (foundId) {
        post({ type: "highlightTap", id: foundId });
      }
    } catch (_) { /* swallow — non-fatal */ }
  }

  // RN asks the bootstrap to scroll the iframe so a bottom-of-page
  // selection moves up enough to leave room for the SelectionBar.
  // delta is in CSS pixels; positive scrolls content up. delta=0
  // restores the natural position. Continuous-manager reader uses
  // outer-doc scroll (window.scrollBy on the WebView); paginated
  // mode uses transform on the iframe wrapper.
  function cheatUp(delta) {
    try {
      // Translate every iframe by `-delta` so they slide up. Setting
      // back to 0 restores. Keeps the implementation manager-agnostic
      // — works for paginated and scroll modes alike.
      var ifr = document.querySelectorAll("iframe");
      for (var i = 0; i < ifr.length; i++) {
        var fr = ifr[i];
        fr.style.transition = "transform 120ms ease-out";
        fr.style.transform = delta === 0 ? "none" : "translateY(" + (-delta) + "px)";
      }
    } catch (_) { /* swallow */ }
  }

  function highlightFillFor(color) {
    switch (color) {
      case "pink":   return "#e89bb6";
      case "green":  return "#9bc88a";
      case "blue":   return "#9abad8";
      case "orange": return "#e8a766";
      case "yellow":
      default:       return "#f5d761";
    }
  }

  // Copy whichever iframe currently owns the live selection. Works
  // because execCommand("copy") respects the iframe's own document
  // selection, not the outer window's. On failure the SelectionBar's
  // user just doesn't see clipboard contents update — non-fatal.
  function copyActiveSelection() {
    try {
      var iframes = document.querySelectorAll("iframe");
      for (var i = 0; i < iframes.length; i++) {
        try {
          var w = iframes[i].contentWindow;
          var d = iframes[i].contentDocument;
          if (!w || !d) continue;
          var sel = w.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().length > 0) {
            d.execCommand && d.execCommand("copy");
            return;
          }
        } catch (_) { /* cross-origin — skip */ }
      }
    } catch (_) { /* swallow */ }
  }

  // Clear selection in every iframe currently mounted. epubjs's
  // continuous manager keeps adjacent pages in adjacent iframes; the
  // active selection always lives in exactly one of them but we don't
  // know which from RN's vantage point — clearing all is cheap and
  // idempotent.
  function clearAllSelections() {
    try {
      var iframes = document.querySelectorAll("iframe");
      for (var i = 0; i < iframes.length; i++) {
        try {
          var w = iframes[i].contentWindow;
          if (w && w.getSelection) {
            var sel = w.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
          }
        } catch (_) { /* cross-origin frame — ignore */ }
      }
    } catch (_) { /* swallow */ }
  }

  setupTapZones();
  showStatus("Ready");
  post({ type: "boot" });
})();
