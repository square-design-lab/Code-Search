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

  // Squarespace renders the editor inside the backend iframe (window.top).
  var win = window.top;
  var doc = win.document;

  // ===== Module state =====
  // One independent search widget is attached per CodeMirror editor on the
  // page. Custom CSS pages have a single editor; the code-injection page has
  // two (header + footer), so instances are tracked as a list.
  var instances = []; // [{ cmRoot, containerEl, setOpen, isOpen, destroy }]
  var locationPollHandle = null;
  var lastPathname = null;
  var globalKeydownHandler = null;

  // ===== Shared helpers =====
  function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildCacheBustedUrl(url) {
    try {
      var base =
        doc.baseURI || (doc.location && doc.location.href) || undefined;
      var parsed = new URL(url, base);
      parsed.searchParams.set("_cb", String(Date.now()));
      return parsed.toString();
    } catch (_e) {
      var sep = url.indexOf("?") === -1 ? "?" : "&";
      return url + sep + "_cb=" + Date.now();
    }
  }

  // Loads the external stylesheet once per document.
  function ensureExternalStylesInjected() {
    return new Promise(function (resolve) {
      var head = doc.head || doc.getElementsByTagName("head")[0];
      if (!head || doc.getElementById("css-search-stylesheet")) {
        resolve();
        return;
      }
      var link = doc.createElement("link");
      link.id = "css-search-stylesheet";
      link.rel = "stylesheet";
      link.href = buildCacheBustedUrl(CSS_URL);
      link.onload = function () {
        resolve();
      };
      link.onerror = function () {
        resolve();
      };
      head.appendChild(link);
    });
  }

  // Builds a friendly placeholder from a nearby field label.
  function detectEditorLabel(cmRoot) {
    try {
      var node = cmRoot.parentElement;
      for (var depth = 0; depth < 6 && node; depth++) {
        var labelEl = node.querySelector(
          "label, legend, .field-title, [class*='title']"
        );
        var text = labelEl && labelEl.textContent && labelEl.textContent.trim();
        if (text && text.length <= 40) return text;
        node = node.parentElement;
      }
    } catch (_e) {}
    return null;
  }

  var ICONS = {
    search:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
    up: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    close:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };

  function makeIconButton(className, ariaLabel, innerHtml) {
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className + " icon-container";
    btn.setAttribute("aria-label", ariaLabel);
    btn.title = ariaLabel;
    btn.innerHTML = innerHtml;
    return btn;
  }

  // Removes any leftover search widgets inside an editor (guards duplicates).
  function clearWidgetsIn(cmRoot) {
    var existing = cmRoot.querySelectorAll(".css-search-container");
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
    }
  }

  // ===========================================================================
  // Per-editor search widget. Fully self-contained: its own UI, option state,
  // highlight state, and listeners, so multiple editors never interfere.
  // ===========================================================================
  function createEditorSearch(cmRoot) {
    var cm = cmRoot.CodeMirror || null;
    var codeRootEl = cmRoot.querySelector(".CodeMirror-code");

    // Search options (per VS Code find widget)
    var opts = {caseSensitive: false, wholeWord: false, useRegex: false};

    // Highlight state
    var currentMatches = []; // CodeMirror: [{from,to}]; DOM: [<mark>]
    var currentIndex = -1;
    var cmMarks = []; // CodeMirror TextMarker objects

    // Claim this editor: clear any leftover widget and mark the element so
    // no other call (concurrent or from a double-loaded script) attaches again.
    clearWidgetsIn(cmRoot);
    cmRoot.setAttribute("data-sdl-search", "1");

    // ---- Build UI ----
    var label = detectEditorLabel(cmRoot);

    var container = doc.createElement("div");
    container.className = "css-search-container";

    var toggle = makeIconButton("css-search-toggle", "Find (Ctrl/Cmd+F)", ICONS.search);

    var wrapper = doc.createElement("div");
    wrapper.className = "css-search-wrapper";

    var bar = doc.createElement("div");
    bar.className = "css-search-bar";

    var inputContainer = doc.createElement("div");
    inputContainer.className = "css-search-input-container";

    var input = doc.createElement("input");
    input.type = "text";
    input.className = "css-search-input";
    input.placeholder = "Find" + (label ? " in " + label : "");
    input.autocomplete = "off";
    input.spellcheck = false;

    var count = doc.createElement("span");
    count.className = "css-search-count";
    count.textContent = "";

    inputContainer.appendChild(input);
    inputContainer.appendChild(count);

    // Option toggles: Aa / ab / .*
    var options = doc.createElement("div");
    options.className = "css-search-options";
    var caseBtn = makeIconButton("css-search-opt", "Match Case", "Aa");
    caseBtn.setAttribute("data-opt", "case");
    var wordBtn = makeIconButton("css-search-opt", "Match Whole Word", "ab");
    wordBtn.setAttribute("data-opt", "word");
    var regexBtn = makeIconButton("css-search-opt", "Use Regular Expression", ".*");
    regexBtn.setAttribute("data-opt", "regex");
    options.appendChild(caseBtn);
    options.appendChild(wordBtn);
    options.appendChild(regexBtn);

    var nav = doc.createElement("div");
    nav.className = "css-search-nav";
    var prev = makeIconButton("css-search-arrow", "Previous match (Shift+Enter)", ICONS.up);
    var next = makeIconButton("css-search-arrow", "Next match (Enter)", ICONS.down);
    var close = makeIconButton("css-search-close", "Close (Esc)", ICONS.close);
    nav.appendChild(prev);
    nav.appendChild(next);
    nav.appendChild(close);

    bar.appendChild(inputContainer);
    bar.appendChild(options);
    bar.appendChild(nav);

    var credit = doc.createElement("p");
    credit.className = "css-search-credit";
    credit.innerHTML =
      '<span class="css-search-credit-text">built by <a href="https://squaredesignlab.com" target="_blank" rel="noopener noreferrer">squaredesignlab.com</a></span>';

    wrapper.appendChild(bar);
    wrapper.appendChild(credit);
    container.appendChild(toggle);
    container.appendChild(wrapper);
    cmRoot.prepend(container);

    // ---- Regex construction from input + active options ----
    function buildRegex(term) {
      var flags = "g" + (opts.caseSensitive ? "" : "i");
      var pattern = opts.useRegex ? term : escapeRegExp(term);
      if (opts.wholeWord) pattern = "\\b(?:" + pattern + ")\\b";
      try {
        return new RegExp(pattern, flags);
      } catch (_e) {
        return null; // invalid user-supplied regex
      }
    }

    // ---- Counter ----
    function updateCounter(invalid) {
      if (invalid) {
        count.textContent = "Invalid regex";
        return;
      }
      var term = input.value.trim();
      if (!term) {
        count.textContent = "";
        return;
      }
      var total = currentMatches.length;
      count.textContent =
        total === 0 ? "No results" : currentIndex + 1 + "/" + total;
    }

    // ---- CodeMirror highlighting (primary path) ----
    function clearCmMarks() {
      for (var i = 0; i < cmMarks.length; i++) {
        try {
          cmMarks[i].clear();
        } catch (_e) {}
      }
      cmMarks = [];
    }

    function collectCmMatches(regex) {
      clearCmMarks();
      var text = typeof cm.getValue === "function" ? cm.getValue() : "";
      var ranges = [];
      var match;
      while ((match = regex.exec(text)) !== null) {
        var from = cm.posFromIndex(match.index);
        var to = cm.posFromIndex(match.index + match[0].length);
        cmMarks.push(cm.markText(from, to, {className: "css-search-hit"}));
        ranges.push({from: from, to: to});
        if (match[0].length === 0) regex.lastIndex++; // guard zero-length
      }
      return ranges;
    }

    // ---- DOM highlighting (fallback when CodeMirror API is unavailable) ----
    function wrapMatchesInTextNode(textNode, regex) {
      var originalText = textNode.nodeValue;
      if (!originalText || !regex.test(originalText)) return [];
      regex.lastIndex = 0;
      var fragment = doc.createDocumentFragment();
      var lastIndex = 0;
      var createdMarks = [];
      var match;
      while ((match = regex.exec(originalText)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(
            doc.createTextNode(originalText.slice(lastIndex, match.index))
          );
        }
        var mark = doc.createElement("mark");
        mark.className = "css-search-hit";
        mark.textContent = match[0];
        fragment.appendChild(mark);
        createdMarks.push(mark);
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) regex.lastIndex++;
      }
      if (lastIndex < originalText.length) {
        fragment.appendChild(doc.createTextNode(originalText.slice(lastIndex)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
      return createdMarks;
    }

    function collectDomMatches(regex) {
      if (!codeRootEl) return [];
      var walker = doc.createTreeWalker(codeRootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          return node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      var textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      var allMarks = [];
      for (var i = 0; i < textNodes.length; i++) {
        var created = wrapMatchesInTextNode(textNodes[i], regex);
        if (created.length) allMarks.push.apply(allMarks, created);
      }
      return allMarks;
    }

    // ---- Run a search for the current input + options ----
    function runSearch() {
      removeHighlights();
      var term = input.value.trim();
      if (!term) {
        updateCounter(false);
        return;
      }
      var regex = buildRegex(term);
      if (!regex) {
        inputContainer.classList.add("is-invalid");
        updateCounter(true);
        return;
      }
      inputContainer.classList.remove("is-invalid");

      currentMatches = cm ? collectCmMatches(regex) : collectDomMatches(regex);
      if (currentMatches.length > 0) {
        setActiveHit(0, true);
      } else {
        currentIndex = -1;
        updateCounter(false);
      }
    }

    function removeHighlights() {
      if (cm) {
        clearCmMarks();
      } else if (codeRootEl) {
        var marks = codeRootEl.querySelectorAll(".css-search-hit");
        marks.forEach(function (mark) {
          var parent = mark.parentNode;
          if (!parent) return;
          parent.replaceChild(doc.createTextNode(mark.textContent || ""), mark);
          parent.normalize();
        });
      }
      currentMatches = [];
      currentIndex = -1;
    }

    // ---- Navigation ----
    function setActiveHit(index, shouldScroll) {
      if (currentMatches.length === 0) return;
      currentIndex = Math.max(0, Math.min(index, currentMatches.length - 1));
      var active = currentMatches[currentIndex];

      if (cm) {
        try {
          if (typeof cm.setSelection === "function") {
            cm.setSelection(active.from, active.to);
          }
          if (shouldScroll && typeof cm.scrollIntoView === "function") {
            cm.scrollIntoView({from: active.from, to: active.to}, 80);
          }
        } catch (_e) {}
      } else {
        currentMatches.forEach(function (el) {
          el.classList && el.classList.remove("css-search-hit--active");
        });
        if (active && active.classList) {
          active.classList.add("css-search-hit--active");
          if (shouldScroll && typeof active.scrollIntoView === "function") {
            try {
              active.scrollIntoView({
                block: "center",
                inline: "nearest",
                behavior: "instant",
              });
            } catch (_e) {
              active.scrollIntoView();
            }
          }
        }
      }
      updateCounter(false);
    }

    function goToNext() {
      if (currentMatches.length === 0) return;
      setActiveHit((currentIndex + 1) % currentMatches.length, true);
    }

    function goToPrev() {
      if (currentMatches.length === 0) return;
      setActiveHit(
        (currentIndex - 1 + currentMatches.length) % currentMatches.length,
        true
      );
    }

    // ---- Option toggles ----
    function toggleOption(key, btn) {
      opts[key] = !opts[key];
      btn.classList.toggle("is-active", opts[key]);
      runSearch();
      input.focus({preventScroll: true});
    }

    // ---- Open / close ----
    function isOpen() {
      return container.classList.contains("css-search--shown");
    }

    function setOpen(shouldShow) {
      container.classList.toggle("css-search--shown", !!shouldShow);
      container.classList.toggle("css-search--hidden", !shouldShow);
      if (!shouldShow) {
        removeHighlights();
        updateCounter(false);
        return;
      }
      try {
        input.focus({preventScroll: true});
        input.select();
        if (input.value.trim()) runSearch();
        win.requestAnimationFrame(function () {
          try {
            input.focus({preventScroll: true});
            input.select();
          } catch (_e) {}
        });
      } catch (_e) {}
    }

    // ---- Events ----
    input.addEventListener("input", runSearch);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) goToPrev();
        else goToNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    });
    prev.addEventListener("click", goToPrev);
    next.addEventListener("click", goToNext);
    caseBtn.addEventListener("click", function () {
      toggleOption("caseSensitive", caseBtn);
    });
    wordBtn.addEventListener("click", function () {
      toggleOption("wholeWord", wordBtn);
    });
    regexBtn.addEventListener("click", function () {
      toggleOption("useRegex", regexBtn);
    });
    toggle.addEventListener("click", function () {
      setOpen(true);
    });
    close.addEventListener("click", function () {
      setOpen(false);
    });

    // Start collapsed (icon only)
    setOpen(false);

    function destroy() {
      removeHighlights();
      if (container.parentNode) container.parentNode.removeChild(container);
      try { cmRoot.removeAttribute("data-sdl-search"); } catch (_e) {}
    }

    return {
      cmRoot: cmRoot,
      containerEl: container,
      setOpen: setOpen,
      isOpen: isOpen,
      destroy: destroy,
    };
  }

  // ===========================================================================
  // Module orchestration: location watching + instance lifecycle
  // ===========================================================================
  function isOnTargetPage(pathname) {
    return TARGET_PATHS.indexOf(pathname) !== -1;
  }

  // An element is "live" as long as it exists in the document.
  // We intentionally do NOT check offsetParent/visibility — Squarespace's panel
  // is inside a position:fixed container, which makes offsetParent null even
  // when the editor is fully visible. Only remove an instance when the element
  // is actually detached from the DOM.
  function isLiveEditor(cmRoot) {
    return doc.contains(cmRoot);
  }

  // Reconciles live editors with active instances: attaches to new editors and
  // drops instances whose editor has been removed from the DOM.
  // A data attribute on each cmRoot prevents any duplicate widget even if this
  // function is called concurrently or the script tag runs more than once.
  async function syncInstances() {
    if (!isOnTargetPage(win.location.pathname)) {
      teardownAllInstances();
      return;
    }

    // Drop instances whose editor was removed from the DOM.
    instances = instances.filter(function (inst) {
      if (!isLiveEditor(inst.cmRoot)) {
        inst.destroy();
        return false;
      }
      return true;
    });

    var editors = Array.prototype.slice.call(doc.querySelectorAll(".CodeMirror"));
    editors = editors.filter(isLiveEditor);

    if (editors.length === 0) return; // not rendered yet; poll will retry

    await ensureExternalStylesInjected();

    editors.forEach(function (cmRoot) {
      // Dual guard: check both the instances array AND the DOM attribute so
      // that concurrent calls or a double-loaded script can never attach twice.
      var alreadyTracked = instances.some(function (inst) {
        return inst.cmRoot === cmRoot;
      });
      if (!alreadyTracked && !cmRoot.hasAttribute("data-sdl-search")) {
        instances.push(createEditorSearch(cmRoot));
      }
    });

    addGlobalKeydownHandler();
  }

  function teardownAllInstances() {
    instances.forEach(function (inst) {
      inst.destroy();
    });
    instances = [];
    removeGlobalKeydownHandler();
  }

  // Ctrl/Cmd+F toggles the widget for whichever editor currently has focus.
  function addGlobalKeydownHandler() {
    if (globalKeydownHandler) return;
    globalKeydownHandler = function (event) {
      try {
        var key = (event.key || "").toLowerCase();
        if (key !== "f" || !(event.metaKey || event.ctrlKey)) return;

        var activeEl = doc.activeElement;
        if (!activeEl) return;

        var target = null;
        for (var i = 0; i < instances.length; i++) {
          var inst = instances[i];
          if (
            inst.cmRoot.contains(activeEl) ||
            inst.containerEl.contains(activeEl)
          ) {
            target = inst;
            break;
          }
        }
        if (!target) return;

        event.preventDefault();
        try {
          event.stopImmediatePropagation();
        } catch (_e) {}
        try {
          event.stopPropagation();
        } catch (_e) {}
        target.setOpen(!target.isOpen());
      } catch (_e) {}
    };
    win.addEventListener("keydown", globalKeydownHandler, true);
  }

  function removeGlobalKeydownHandler() {
    if (!globalKeydownHandler) return;
    try {
      win.removeEventListener("keydown", globalKeydownHandler, true);
    } catch (_e) {}
    globalKeydownHandler = null;
  }

  function startWatchingParentLocation() {
    if (locationPollHandle) return;
    lastPathname = win.location.pathname;
    locationPollHandle = win.setInterval(function () {
      var pathname = win.location.pathname;
      if (pathname !== lastPathname) lastPathname = pathname;
      // Re-sync every tick: handles page changes and editors (re)rendering.
      syncInstances();
    }, POLL_INTERVAL_MS);
  }

  function init() {
    try {
      startWatchingParentLocation();
      syncInstances();
    } catch (error) {
      console.warn("CodeSearch init failed:", error);
    }
  }

  // Only run inside the Squarespace backend iframe.
  if (window.top !== window.self) {
    init();
  }
})();
