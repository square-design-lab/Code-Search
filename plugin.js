(function () {
  "use strict";

  // ===== Configuration =====
  var TARGET_PATHS = [
    "/config/pages/custom-css",
    "/config/pages/custom-css-popup",
    "/config/pages/code-injection",
  ];
  var CSS_URL = "https://code-search-5wf.pages.dev/plugin.css";
  var POLL_INTERVAL_MS = 800;
  // Editors shorter than this (px) are 1-line UI widgets, not real code fields.
  var MIN_EDITOR_HEIGHT = 80;
  // Cap highlights to avoid blocking the UI thread on large editors.
  var MAX_MATCHES = 200;
  // Debounce delay (ms) — search fires this long after the user stops typing.
  var SEARCH_DEBOUNCE_MS = 250;

  var win = window.top;
  var doc = win.document;

  var instances = [];
  var locationPollHandle = null;
  var globalKeydownHandler = null;

  // ===== Helpers =====
  function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildCacheBustedUrl(url) {
    try {
      var parsed = new URL(url, doc.baseURI || undefined);
      parsed.searchParams.set("_cb", String(Date.now()));
      return parsed.toString();
    } catch (_e) {
      return url + (url.indexOf("?") === -1 ? "?" : "&") + "_cb=" + Date.now();
    }
  }

  function ensureExternalStylesInjected() {
    return new Promise(function (resolve) {
      var head = doc.head || doc.getElementsByTagName("head")[0];
      if (!head || doc.getElementById("code-search-stylesheet")) { resolve(); return; }
      var link = doc.createElement("link");
      link.id = "code-search-stylesheet";
      link.rel = "stylesheet";
      link.href = buildCacheBustedUrl(CSS_URL);
      link.onload = function () { resolve(); };
      link.onerror = function () { resolve(); };
      head.appendChild(link);
    });
  }

  function detectEditorLabel(cmRoot) {
    try {
      var node = cmRoot.parentElement;
      for (var d = 0; d < 6 && node; d++) {
        var el = node.querySelector("label, legend, .field-title, [class*='title']");
        var txt = el && (el.textContent || "").trim();
        if (txt && txt.length <= 40) return txt;
        node = node.parentElement;
      }
    } catch (_e) {}
    return null;
  }

  var ICONS = {
    search: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
    up:     '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down:   '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    close:  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };

  function makeBtn(className, label, html) {
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className + " icon-container";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.innerHTML = html;
    return btn;
  }

  function clearWidgetsIn(cmRoot) {
    var els = cmRoot.querySelectorAll(".code-search-container");
    for (var i = 0; i < els.length; i++) {
      if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
  }

  // ===========================================================================
  // Per-editor widget — fully self-contained
  // ===========================================================================
  function createEditorSearch(cmRoot) {
    var cm = (cmRoot.CodeMirror && typeof cmRoot.CodeMirror.getValue === "function")
      ? cmRoot.CodeMirror : null;
    var codeRootEl = cmRoot.querySelector(".CodeMirror-code");

    var opts = {caseSensitive: false};
    // currentMatches: raw char-index pairs [{start,end}] — no CM positions stored.
    // lineStarts: precomputed newline offsets for fast binary-search index→pos conversion.
    // activeMark: the single markText mark for the currently highlighted match.
    var currentMatches = [];
    var currentIndex = -1;
    var lineStarts = [];
    var activeMark = null;

    clearWidgetsIn(cmRoot);
    cmRoot.setAttribute("data-sdl-search", "1");

    // ---- Build UI ----
    var label = detectEditorLabel(cmRoot);

    var container = doc.createElement("div");
    container.className = "code-search-container";

    var toggle = makeBtn("code-search-toggle", "Find  (Ctrl/Cmd+F)", ICONS.search);

    var wrapper = doc.createElement("div");
    wrapper.className = "code-search-wrapper";

    // Row 1: input + count + nav
    var bar = doc.createElement("div");
    bar.className = "code-search-bar";

    var inputWrap = doc.createElement("div");
    inputWrap.className = "code-search-input-container";

    var input = doc.createElement("input");
    input.type = "text";
    input.className = "code-search-input";
    input.placeholder = "Find" + (label ? " in " + label : "");
    input.autocomplete = "off";
    input.setAttribute("spellcheck", "false");
    inputWrap.appendChild(input);
    bar.appendChild(inputWrap);

    // Count sits BETWEEN the input and the nav buttons
    var count = doc.createElement("span");
    count.className = "code-search-count";
    count.textContent = "";
    bar.appendChild(count);

    var nav = doc.createElement("div");
    nav.className = "code-search-nav";
    var prev  = makeBtn("code-search-arrow", "Previous (Shift+Enter)", ICONS.up);
    var next  = makeBtn("code-search-arrow", "Next (Enter)",           ICONS.down);
    var close = makeBtn("code-search-close", "Close (Esc)",            ICONS.close);
    nav.appendChild(prev);
    nav.appendChild(next);
    nav.appendChild(close);
    bar.appendChild(nav);
    wrapper.appendChild(bar);

    // Row 2: status message (hidden by default)
    var message = doc.createElement("div");
    message.className = "code-search-message";
    message.style.display = "none";
    wrapper.appendChild(message);

    // Row 3: credit
    var credit = doc.createElement("p");
    credit.className = "code-search-credit";
    credit.innerHTML = '<span class="code-search-credit-text">built by <a href="https://squaredesignlab.com" target="_blank" rel="noopener noreferrer">squaredesignlab.com</a></span>';
    wrapper.appendChild(credit);

    container.appendChild(toggle);
    container.appendChild(wrapper);

    // Insert before .CodeMirror-scroll so we don't disturb CodeMirror's textarea
    var scrollEl = cmRoot.querySelector(".CodeMirror-scroll");
    if (scrollEl) cmRoot.insertBefore(container, scrollEl);
    else cmRoot.prepend(container);

    // ---- Counter ----
    function updateCounter(state) {
      // state: "invalid" | "noresults" | "ok" | "empty"
      if (state === "invalid") {
        count.textContent = "";
        message.textContent = "Invalid expression";
        message.style.display = "block";
        return;
      }
      if (state === "empty") {
        count.textContent = "";
        message.style.display = "none";
        return;
      }
      if (state === "noresults") {
        count.textContent = "0/0";
        message.textContent = "No results found";
        message.style.display = "block";
        return;
      }
      // "ok"
      var total = currentMatches.length >= MAX_MATCHES ? MAX_MATCHES + "+" : currentMatches.length;
      count.textContent = (currentIndex + 1) + "/" + total;
      message.style.display = "none";
    }

    // ---- CodeMirror highlighting ----
    // Binary search: convert a char index to a CM {line, ch} position using the
    // precomputed lineStarts array. O(log lines) vs cm.posFromIndex's O(lines).
    function indexToPos(idx) {
      var lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
      }
      return {line: lo, ch: idx - lineStarts[lo]};
    }

    function clearActiveMark() {
      if (activeMark) { try { activeMark.clear(); } catch (_e) {} activeMark = null; }
    }

    function collectCmMatches(regex) {
      clearActiveMark();
      var text = cm.getValue();
      // Build lineStarts once — O(text.length). Kept in closure for setActiveHit.
      lineStarts = [0];
      for (var ci = 0; ci < text.length; ci++) {
        if (text[ci] === "\n") lineStarts.push(ci + 1);
      }
      // Collect raw char indices only — zero CM API calls here.
      var raw = [];
      var match;
      while ((match = regex.exec(text)) !== null) {
        if (raw.length >= MAX_MATCHES) break;
        raw.push({start: match.index, end: match.index + match[0].length});
        if (match[0].length === 0) regex.lastIndex++;
      }
      return raw;
    }

    // ---- DOM highlighting (fallback) ----
    function wrapTextNode(textNode, regex) {
      var src = textNode.nodeValue;
      if (!src || !regex.test(src)) return [];
      regex.lastIndex = 0;
      var frag = doc.createDocumentFragment();
      var last = 0;
      var marks = [];
      var m;
      while ((m = regex.exec(src)) !== null) {
        if (m.index > last) frag.appendChild(doc.createTextNode(src.slice(last, m.index)));
        var mark = doc.createElement("mark");
        mark.className = "code-search-hit";
        mark.textContent = m[0];
        frag.appendChild(mark);
        marks.push(mark);
        last = m.index + m[0].length;
        if (m[0].length === 0) regex.lastIndex++;
      }
      if (last < src.length) frag.appendChild(doc.createTextNode(src.slice(last)));
      if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
      return marks;
    }

    function collectDomMatches(regex) {
      if (!codeRootEl) return [];
      var walker = doc.createTreeWalker(codeRootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      var all = [];
      for (var i = 0; i < nodes.length; i++) {
        var created = wrapTextNode(nodes[i], regex);
        if (created.length) all.push.apply(all, created);
      }
      return all;
    }

    // ---- Search ----
    function buildRegex(term) {
      var flags = "g" + (opts.caseSensitive ? "" : "i");
      try { return new RegExp(escapeRegExp(term), flags); } catch (_e) { return null; }
    }

    function removeHighlights() {
      if (cm) {
        clearActiveMark();
        lineStarts = [];
      } else if (codeRootEl) {
        var hits = codeRootEl.querySelectorAll(".code-search-hit");
        hits.forEach(function (h) {
          var p = h.parentNode;
          if (!p) return;
          p.replaceChild(doc.createTextNode(h.textContent || ""), h);
          p.normalize();
        });
      }
      currentMatches = [];
      currentIndex = -1;
    }

    function runSearch() {
      removeHighlights();
      var term = input.value.trim();
      if (!term) { updateCounter("empty"); return; }
      var regex = buildRegex(term);
      if (!regex) { inputWrap.classList.add("is-invalid"); updateCounter("invalid"); return; }
      inputWrap.classList.remove("is-invalid");
      currentMatches = cm ? collectCmMatches(regex) : collectDomMatches(regex);
      if (currentMatches.length > 0) setActiveHit(0, true);
      else { currentIndex = -1; updateCounter("noresults"); }
    }

    // ---- Navigation ----
    function setActiveHit(index, scroll) {
      if (!currentMatches.length) return;
      currentIndex = Math.max(0, Math.min(index, currentMatches.length - 1));
      var raw = currentMatches[currentIndex];
      if (cm) {
        // Convert only the ONE active match — 2 binary searches, zero freezing.
        clearActiveMark();
        var from = indexToPos(raw.start);
        var to   = indexToPos(raw.end);
        try { activeMark = cm.markText(from, to, {className: "code-search-hit code-search-hit--active"}); } catch (_e) {}
        try { if (typeof cm.setSelection === "function") cm.setSelection(from, to); } catch (_e) {}
        try {
          if (scroll && typeof cm.scrollIntoView === "function")
            cm.scrollIntoView({from: from, to: to}, 80);
        } catch (_e) {}
      } else {
        currentMatches.forEach(function (el) {
          el.classList && el.classList.remove("code-search-hit--active");
        });
        if (raw && raw.classList) {
          raw.classList.add("code-search-hit--active");
          if (scroll) {
            try { raw.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"}); }
            catch (_e) { try { raw.scrollIntoView(); } catch (_e2) {} }
          }
        }
      }
      updateCounter("ok");
    }

    function goNext() { if (currentMatches.length) setActiveHit((currentIndex + 1) % currentMatches.length, true); }
    function goPrev() { if (currentMatches.length) setActiveHit((currentIndex - 1 + currentMatches.length) % currentMatches.length, true); }

    // ---- Open/close ----
    function isOpen() { return container.classList.contains("code-search--shown"); }

    function setOpen(show) {
      container.classList.toggle("code-search--shown", !!show);
      container.classList.toggle("code-search--hidden", !show);
      if (!show) { removeHighlights(); updateCounter("empty"); return; }
      try {
        input.focus({preventScroll: true});
        input.select();
        if (input.value.trim()) runSearch();
        win.requestAnimationFrame(function () {
          try { input.focus({preventScroll: true}); input.select(); } catch (_e) {}
        });
      } catch (_e) {}
    }

    // ---- Events ----
    var searchDebounceTimer = null;
    function debouncedSearch() {
      if (searchDebounceTimer) win.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = win.setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    }
    input.addEventListener("input", debouncedSearch);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goPrev() : goNext(); }
      else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    });
    prev.addEventListener("click",  goPrev);
    next.addEventListener("click",  goNext);
    toggle.addEventListener("click", function () { setOpen(true); });
    close.addEventListener("click",  function () { setOpen(false); });

    setOpen(false);

    function destroy() {
      removeHighlights();
      if (container.parentNode) container.parentNode.removeChild(container);
      try { cmRoot.removeAttribute("data-sdl-search"); } catch (_e) {}
    }

    return {cmRoot: cmRoot, containerEl: container, setOpen: setOpen, isOpen: isOpen, destroy: destroy};
  }

  // ===========================================================================
  // Orchestration
  // ===========================================================================
  function isOnTargetPage(pathname) {
    return TARGET_PATHS.indexOf(pathname) !== -1;
  }

  function isRealEditor(cmRoot) {
    // Must be in the DOM, have a working CM API, and be tall enough to be a
    // real code field (not a 1-line Squarespace UI widget — those cause crashes
    // when we prepend into them because they have 1-line layout assumptions).
    return doc.contains(cmRoot)
      && cmRoot.CodeMirror
      && typeof cmRoot.CodeMirror.getValue === "function"
      && cmRoot.offsetHeight >= MIN_EDITOR_HEIGHT;
  }

  async function syncInstances() {
    if (!isOnTargetPage(win.location.pathname)) {
      teardownAllInstances();
      return;
    }

    // Drop instances whose editor is gone
    instances = instances.filter(function (inst) {
      if (!doc.contains(inst.cmRoot)) { inst.destroy(); return false; }
      return true;
    });

    var editors = Array.prototype.slice.call(doc.querySelectorAll(".CodeMirror")).filter(isRealEditor);
    if (editors.length === 0) return;

    await ensureExternalStylesInjected();

    editors.forEach(function (cmRoot) {
      var tracked = instances.some(function (inst) { return inst.cmRoot === cmRoot; });
      if (!tracked && !cmRoot.hasAttribute("data-sdl-search")) {
        instances.push(createEditorSearch(cmRoot));
      }
    });

    addGlobalKeydownHandler();
  }

  function teardownAllInstances() {
    instances.forEach(function (inst) { inst.destroy(); });
    instances = [];
    removeGlobalKeydownHandler();
  }

  function addGlobalKeydownHandler() {
    if (globalKeydownHandler) return;
    globalKeydownHandler = function (event) {
      try {
        if ((event.key || "").toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
        var activeEl = doc.activeElement;
        if (!activeEl) return;
        var target = null;
        for (var i = 0; i < instances.length; i++) {
          var inst = instances[i];
          if (inst.cmRoot.contains(activeEl) || inst.containerEl.contains(activeEl)) {
            target = inst; break;
          }
        }
        if (!target) return;
        event.preventDefault();
        try { event.stopImmediatePropagation(); } catch (_e) {}
        try { event.stopPropagation(); } catch (_e) {}
        target.setOpen(!target.isOpen());
      } catch (_e) {}
    };
    win.addEventListener("keydown", globalKeydownHandler, true);
  }

  function removeGlobalKeydownHandler() {
    if (!globalKeydownHandler) return;
    try { win.removeEventListener("keydown", globalKeydownHandler, true); } catch (_e) {}
    globalKeydownHandler = null;
  }

  function startWatchingParentLocation() {
    if (locationPollHandle) return;
    locationPollHandle = win.setInterval(syncInstances, POLL_INTERVAL_MS);
  }

  function init() {
    try {
      startWatchingParentLocation();
      syncInstances();
    } catch (err) {
      console.warn("CodeSearch init failed:", err);
    }
  }

  // Run only inside the Squarespace backend iframe, and only once per session.
  if (window.top !== window.self && !window.top._sdlCodeSearch) {
    window.top._sdlCodeSearch = true;
    init();
  }
})();
