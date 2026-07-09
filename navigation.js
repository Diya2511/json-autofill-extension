/* Reusable navigation engine for multi-step web applications. */

const JsonAutofillNavigation = (() => {
  const Utils = JsonAutofillUtils;

  const DEFAULT_CONFIG = Object.freeze({
    minScore: 55,
    maxRetries: 2,
    transitionTimeoutMs: 3500,
    settleDelayMs: 350,
    candidateSelectors: [
      "button",
      "a[href]",
      "[role='button']",
      "input[type='button']",
      "input[type='submit']",
      "[data-action]",
      "[data-testid]",
      "[data-test]",
      "[data-cy]"
    ],
    positiveTerms: [
      "next",
      "continue",
      "save continue",
      "save and continue",
      "save next",
      "save and next",
      "proceed",
      "review",
      "continue to next section",
      "go to next",
      "next section"
    ],
    negativeTerms: [
      "back",
      "previous",
      "cancel",
      "close",
      "delete",
      "quit",
      "save quit",
      "save and quit",
      "print",
      "download",
      "help"
    ]
  });

  function normalize(value) {
    return Utils.normalizeKey(value);
  }

  function visibleText(element) {
    return String(element?.innerText || element?.textContent || element?.value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function attributeText(element) {
    const attributes = [
      element.id,
      element.name,
      element.className,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("type"),
      element.getAttribute("value"),
      Object.entries(element.dataset || {}).map(([key, value]) => `${key} ${value}`).join(" ")
    ];
    return attributes.filter(Boolean).join(" ");
  }

  function parseSelectorList(value) {
    return String(value || "")
      .split(/\n|,/)
      .map((selector) => selector.trim())
      .filter(Boolean);
  }

  function selectorForElement(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy");
    if (testId) return `[data-testid="${CSS.escape(testId)}"], [data-test="${CSS.escape(testId)}"], [data-cy="${CSS.escape(testId)}"]`;
    if (element.name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(element.name)}"]`;
    const text = normalize(visibleText(element)).slice(0, 40);
    return `${element.tagName.toLowerCase()}::text(${text})`;
  }

  function queryCustomSelectors(selectors) {
    const elements = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((element) => elements.push(element));
      } catch {
        // Invalid user selectors are ignored and reported by low candidate confidence.
      }
    });
    return elements;
  }

  function isCandidate(element, panelId) {
    if (!element || !Utils.isVisible(element)) return false;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    if (panelId && element.closest(`#${panelId}`)) return false;
    if (element.closest("aside, nav, header, footer, [role='navigation']")) return false;
    return true;
  }

  function candidateSignals(element) {
    return `${visibleText(element)} ${attributeText(element)}`;
  }

  function scoreCandidate(element, config, context = {}) {
    const text = normalize(visibleText(element));
    const attrs = normalize(attributeText(element));
    const combined = `${text} ${attrs}`;
    const rect = element.getBoundingClientRect();
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const rightSide = centerX > window.innerWidth * 0.48;
    const lowerHalf = centerY > window.innerHeight * 0.45;
    const areaRatio = (rect.width * rect.height) / viewportArea;
    let score = 0;
    const reasons = [];

    config.positiveTerms.forEach((term) => {
      const normalized = normalize(term);
      if (text === normalized) {
        score += 48;
        reasons.push(`exact text "${term}"`);
      } else if (text.includes(normalized) || attrs.includes(normalized)) {
        score += 30;
        reasons.push(`matched "${term}"`);
      }
    });

    config.negativeTerms.forEach((term) => {
      const normalized = normalize(term);
      if (combined.includes(normalized)) {
        score -= 60;
        reasons.push(`negative "${term}"`);
      }
    });

    if (element.matches("button, input[type='submit']")) {
      score += 12;
      reasons.push("button-like control");
    }
    if (rightSide && lowerHalf) {
      score += 16;
      reasons.push("bottom/right form position");
    } else if (lowerHalf) {
      score += 8;
      reasons.push("lower form position");
    }
    if (areaRatio > 0.0002 && areaRatio < 0.05) score += 4;
    if (context.customSelectors?.some((selector) => {
      try {
        return element.matches?.(selector);
      } catch {
        return false;
      }
    })) {
      score += 80;
      reasons.push("custom selector");
    }
    if (context.learnedSelectors?.some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    })) {
      score += 90;
      reasons.push("learned selector");
    }

    return { element, score, reasons, label: visibleText(element) || attributeText(element), selector: selectorForElement(element) };
  }

  function domFingerprint() {
    const fields = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter((element) => Utils.isVisible(element))
      .slice(0, 30)
      .map((element) => `${element.tagName}:${element.name}:${element.id}:${element.type}`)
      .join("|");
    const heading = visibleText(document.querySelector("h1, h2, [role='heading']"));
    const progress = visibleText(document.querySelector("[aria-current], [aria-selected='true'], progress, [role='progressbar']"));
    return {
      url: location.href,
      heading,
      fields,
      progress,
      bodyLength: document.body?.innerText?.length || 0
    };
  }

  function transitionEvidence(before, after) {
    const evidence = [];
    if (before.url !== after.url) evidence.push("URL changed");
    if (before.heading !== after.heading && after.heading) evidence.push("heading changed");
    if (before.fields !== after.fields) evidence.push("visible fields changed");
    if (before.progress !== after.progress && after.progress) evidence.push("progress changed");
    if (Math.abs(before.bodyLength - after.bodyLength) > 120) evidence.push("DOM text changed");
    return evidence;
  }

  async function waitForTransition(before, config) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < config.transitionTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 140));
      const after = domFingerprint();
      const evidence = transitionEvidence(before, after);
      if (evidence.length) {
        await new Promise((resolve) => setTimeout(resolve, config.settleDelayMs));
        return { ok: true, evidence, after: domFingerprint() };
      }
    }
    return { ok: false, evidence: [], after: domFingerprint() };
  }

  function dispatchSafeClick(element) {
    const navigableAnchor = element.closest?.("a[href]");
    const cancelNativeNavigation = (event) => {
      if (navigableAnchor && (event.target === element || element.contains(event.target))) {
        event.preventDefault();
      }
    };

    window.addEventListener("click", cancelNativeNavigation, { once: true });
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  }

  function verifyRequiredFields() {
    const required = Array.from(document.querySelectorAll("input[required], textarea[required], select[required], [aria-required='true']"))
      .filter((element) => Utils.isVisible(element) && !element.disabled);
    const missing = required.filter((element) => {
      if (element.type === "checkbox" || element.type === "radio") return !element.checked;
      return String(element.value || "").trim() === "";
    });
    return {
      ok: missing.length === 0,
      missing: missing.map((element) => Utils.elementDescriptor(element).displayName || element.name || element.id || element.tagName).slice(0, 8)
    };
  }

  async function loadLearnedSelectors(domain) {
    const key = Utils.STORAGE_KEYS.navigationMappings;
    const data = await chrome.storage.local.get(key);
    return data[key]?.[domain] || [];
  }

  async function saveLearnedSelector(domain, selector) {
    if (!selector || selector.includes("::text")) return;
    const key = Utils.STORAGE_KEYS.navigationMappings;
    const data = await chrome.storage.local.get(key);
    const mappings = data[key] || {};
    mappings[domain] = Utils.unique([selector, ...(mappings[domain] || [])]).slice(0, 8);
    await chrome.storage.local.set({ [key]: mappings });
  }

  async function findNavigationControl(options = {}) {
    const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const customSelectors = parseSelectorList(options.customSelectors);
    const learnedSelectors = await loadLearnedSelectors(options.domain || Utils.getDomain());
    const selector = Utils.unique([...config.candidateSelectors, ...learnedSelectors]).join(",");
    let baseCandidates = [];
    try {
      baseCandidates = Array.from(document.querySelectorAll(selector));
    } catch {
      baseCandidates = Array.from(document.querySelectorAll(config.candidateSelectors.join(",")));
    }
    const candidates = [
      ...queryCustomSelectors(customSelectors),
      ...baseCandidates
    ].filter((element, index, list) => list.indexOf(element) === index)
      .filter((element) => isCandidate(element, options.panelId));

    const scored = candidates
      .map((element) => scoreCandidate(element, config, { customSelectors, learnedSelectors }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < config.minScore) {
      return { ok: false, reason: "No navigation control met the confidence threshold.", candidates: scored.slice(0, 5) };
    }
    return { ok: true, control: best, candidates: scored.slice(0, 5) };
  }

  async function navigate(options = {}) {
    const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const required = verifyRequiredFields();
    if (!required.ok && options.requireRequiredFields !== false) {
      return { ok: false, reason: "Required fields are still empty.", missing: required.missing, manualIntervention: true };
    }

    let lastFailure = null;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
      const found = await findNavigationControl(options);
      if (!found.ok) return { ...found, manualIntervention: true };

      const before = domFingerprint();
      dispatchSafeClick(found.control.element);
      const transition = await waitForTransition(before, config);
      if (transition.ok) {
        await saveLearnedSelector(options.domain || Utils.getDomain(), found.control.selector);
        return {
          ok: true,
          attempt,
          control: found.control,
          evidence: transition.evidence
        };
      }
      lastFailure = {
        reason: "Navigation click did not produce a verified transition.",
        attemptedControl: found.control,
        attempt
      };
    }

    return { ok: false, ...lastFailure, manualIntervention: true };
  }

  return {
    DEFAULT_CONFIG,
    findNavigationControl,
    navigate,
    verifyRequiredFields,
    domFingerprint,
    transitionEvidence
  };
})();
