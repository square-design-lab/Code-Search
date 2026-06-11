(function () {
  "use strict";

  // ===== Configuration =====
  var TARGET_PATHS = [
    "/config/pages/custom-css",
    "/config/pages/custom-css-popup",
    "/config/pages/code-injection",
  ];
  var CSS_URL =
    "https://cdn.jsdelivr.net/gh/squaredesignlab/css-searchbar@0/css-search.min.css";
  var POLL_INTERVAL_MS = 800;

  // Squarespace renders the editor inside the backend iframe (window.top).
  var win = window.top;
  var doc = win.document;

  // ===== Module state =====
  // We attach one independent search box per CodeMirror editor on the page.
  // The custom CSS pages have a single editor; the code-injection page has
  // two (header + footer), so instances are tracked as a list.
  var instances = []; // [{ cmRoot, setOpen, isOpen, destroy }, ...]
  var locationPollHandle = null;
  var lastPathname = null;
  var globalKeydownHandler = null;

  // ===== Small shared helpers =====
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

  // Builds a friendly placeholder by looking for a nearby field label.
  // Falls back to a generic label when nothing meaningful is found.
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
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search-icon lucide-search"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
    up: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-up-icon lucide-chevron-up"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down-icon lucide-chevron-down"><path d="m6 9 6 6 6-6"/></svg>',
    close:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };

  function makeIconButton(className, ariaLabel, iconHtml) {
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className + " icon-container";
    btn.setAttribute("aria-label", ariaLabel);
    btn.innerHTML = iconHtml;
    return btn;
  }

  // ===========================================================================
  // Per-editor search instance
  // Each CodeMirror editor on the page gets one of these. It owns its own UI,
  // highlight state, and event listeners — fully self-contained so multiple
  // editors (e.g. header + footer) never interfere with one another.
  // ===========================================================================
  function createEditorSearch(cmRoot) {
    var cm = cmRoot.CodeMirror || null;
    var codeRootEl = cmRoot.querySelector(".CodeMirror-code");

    // UI references
    var containerEl, inputEl, prevBtn, nextBtn, countEl;

    // Highlight state
    var currentMatches = []; // CodeMirror: [{from,to}]; DOM fallback: [<mark>]
    var currentIndex = -1;
    var cmMarks = []; // CodeMirror TextMarker objects

    // ---- Build UI ----
    var label = detectEditorLabel(cmRoot);
    var placeholder = "Search " + (label || "code") + "…";

    var container = doc.createElement("div");
    container.className = "css-search-container";

    var toggle = makeIconButton("css-search-toggle", "Open search", ICONS.search);

    var wrapper = doc.createElement("div");
    wrapper.className = "css-search-wrapper";

    var bar = doc.createElement("div");
    bar.className = "css-search-bar";

    var inputContainer = doc.createElement("div");
    inputContainer.className = "css-search-input-container";

    var input = doc.createElement("input");
    input.type = "search";
    input.className = "css-search-input";
    input.placeholder = placeholder;
    input.autocomplete = "off";

    var count = doc.createElement("span");
    count.className = "css-search-count";
    count.textContent = "0/0";

    inputContainer.appendChild(input);
    inputContainer.appendChild(count);
    bar.appendChild(inputContainer);

    var nav = doc.createElement("div");
    nav.className = "css-search-nav";
    var prev = makeIconButton("css-search-arrow", "Previous result", ICONS.up);
    var next = makeIconButton("css-search-arrow", "Next result", ICONS.down);
    var close = makeIconButton("css-search-close", "Close search", ICONS.close);
    nav.appendChild(prev);
    nav.appendChild(next);
    nav.appendChild(close);
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

    // Expose references used elsewhere in this closure
    containerEl = container;
    inputEl = input;
    prevBtn = prev;
    nextBtn = next;
    countEl = count;

    // ---- Counter ----
    function updateCounter() {
      var total = currentMatches.length;
      var indexDisplay = total > 0 && currentIndex >= 0 ? currentIndex + 1 : 0;
      countEl.textContent = indexDisplay + "/" + total;
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

    function highlightUsingCodeMirror(term) {
      clearCmMarks();
      var text = typeof cm.getValue === "function" ? cm.getValue() : "";
      var safeTerm = escapeRegExp(term);
      if (!safeTerm) return;
      var regex = new RegExp(safeTerm, "gi");
      var ranges = [];
      var match;
      while ((match = regex.exec(text)) !== null) {
        var from = cm.posFromIndex(match.index);
        var to = cm.posFromIndex(match.index + match[0].length);
        cmMarks.push(cm.markText(from, to, {className: "css-search-hit"}));
        ranges.push({from: from, to: to});
        if (match[0].length === 0) regex.lastIndex++; // guard zero-length
      }
      currentMatches = ranges;
      if (currentMatches.length > 0) {
        setActiveHit(0, true);
      } else {
        currentIndex = -1;
        updateCounter();
      }
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
      if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
      return createdMarks;
    }

    function highlightUsingDom(term) {
      removeHighlights();
      if (!codeRootEl) return;
      var safeTerm = escapeRegExp(term);
      if (!safeTerm) return;
      var regex = new RegExp(safeTerm, "gi");
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
      currentMatches = allMarks;
      if (currentMatches.length > 0) {
        setActiveHit(0, true);
      } else {
        currentIndex = -1;
        updateCounter();
      }
    }

    function highlightTerm(term) {
      if (cm) highlightUsingCodeMirror(term);
      else highlightUsingDom(term);
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
      updateCounter();
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
      updateCounter();
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

    // ---- Open / close ----
    function isOpen() {
      return containerEl.classList.contains("css-search--shown");
    }

    function setOpen(shouldShow) {
      containerEl.classList.toggle("css-search--shown", !!shouldShow);
      containerEl.classList.toggle("css-search--hidden", !shouldShow);
      if (!shouldShow) {
        removeHighlights();
        return;
      }
      try {
        inputEl.focus({preventScroll: true});
        inputEl.select && inputEl.select();
        var existingTerm = String(inputEl.value || "").trim();
        if (existingTerm) highlightTerm(existingTerm);
        win.requestAnimationFrame(function () {
          try {
            inputEl.focus({preventScroll: true});
            inputEl.select && inputEl.select();
          } catch (_e) {}
        });
      } catch (_e) {}
    }

    // ---- Events ----
    input.addEventListener("input", function (e) {
      var term = e.target && e.target.value ? String(e.target.value).trim() : "";
      if (!codeRootEl && !cm) return;
      if (!term) removeHighlights();
      else highlightTerm(term);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        goToNext();
      }
    });
    prev.addEventListener("click", goToPrev);
    next.addEventListener("click", goToNext);
    toggle.addEventListener("click", function () {
      setOpen(true);
    });
    close.addEventListener("click", function () {
      setOpen(false);
    });

    // Start collapsed
    setOpen(false);

    // ---- Public interface ----
    function destroy() {
      removeHighlights();
      if (containerEl.parentNode) {
        containerEl.parentNode.removeChild(containerEl);
      }
    }

    return {
      cmRoot: cmRoot,
      containerEl: containerEl,
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

  // Reconciles the live editors on the page with our active instances:
  // attaches search to new editors, drops instances whose editor is gone.
  async function syncInstances() {
    if (!isOnTargetPage(win.location.pathname)) {
      teardownAllInstances();
      return;
    }

    var editors = Array.prototype.slice.call(doc.querySelectorAll(".CodeMirror"));

    // Remove instances whose editor was detached from the DOM.
    instances = instances.filter(function (inst) {
      if (editors.indexOf(inst.cmRoot) === -1 || !doc.contains(inst.cmRoot)) {
        inst.destroy();
        return false;
      }
      return true;
    });

    if (editors.length === 0) return; // editor not rendered yet; poll will retry

    await ensureExternalStylesInjected();

    editors.forEach(function (cmRoot) {
      var alreadyAttached = instances.some(function (inst) {
        return inst.cmRoot === cmRoot;
      });
      if (!alreadyAttached) {
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

  // Ctrl/Cmd+F toggles the search box for whichever editor currently has focus.
  function addGlobalKeydownHandler() {
    if (globalKeydownHandler) return;
    globalKeydownHandler = function (event) {
      try {
        var key = (event.key || "").toLowerCase();
        if (key !== "f" || !(event.metaKey || event.ctrlKey)) return;

        var activeEl = doc.activeElement;
        if (!activeEl) return;

        // Find the instance whose editor (or search UI) contains focus.
        var target = null;
        for (var i = 0; i < instances.length; i++) {
          var inst = instances[i];
          if (inst.cmRoot.contains(activeEl) || inst.containerEl.contains(activeEl)) {
            target = inst;
            break;
          }
        }
        if (!target) return;

        // Don't hijack typing inside our own input.
        if (target.containerEl.contains(activeEl) && !target.isOpen()) return;

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
      if (pathname !== lastPathname) {
        lastPathname = pathname;
        syncInstances();
      } else if (isOnTargetPage(pathname)) {
        // Same page, but editors may have (re)rendered — keep them in sync.
        syncInstances();
      }
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
