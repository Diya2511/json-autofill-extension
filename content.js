/* Content-side scanner and autofill engine. Loaded into pages on demand by the extension. */

(() => {
  if (window.__jsonAutofillProLoaded) return;
  window.__jsonAutofillProLoaded = true;

  const Utils = JsonAutofillUtils;
  const Mapping = JsonAutofillMapping;

  const FIELD_SELECTOR = "input, textarea, select";
  const SECTION_NAV_SELECTOR = [
    "aside a",
    "aside button",
    "aside li",
    "aside div",
    "aside [role='button']",
    "aside [tabindex]",
    "nav a",
    "nav button",
    "nav li",
    "nav div",
    "nav [role='button']",
    "nav [tabindex]",
    "[aria-label*='section' i] a",
    "[aria-label*='section' i] button",
    "[aria-label*='step' i] a",
    "[aria-label*='step' i] button",
    "[class*='side' i] a",
    "[class*='side' i] button",
    "[class*='side' i] li",
    "[class*='side' i] div",
    "[class*='step' i] a",
    "[class*='step' i] button",
    "[class*='step' i] li",
    "[class*='step' i] div",
    "[class*='wizard' i] a",
    "[class*='wizard' i] button",
    "[class*='wizard' i] li",
    "[class*='wizard' i] div",
    "[class*='nav' i] a",
    "[class*='nav' i] button",
    "[class*='nav' i] li",
    "[class*='nav' i] div"
  ].join(",");
  const HIGHLIGHT_STYLE_ID = "json-autofill-pro-style";
  const PANEL_ID = "json-autofill-pro-panel";
  let lastPayload = null;
  let observer = null;
  let pendingAutoFill = false;

  function ensureStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .json-autofill-filled { outline: 3px solid #20b15a !important; box-shadow: 0 0 0 4px rgba(32, 177, 90, .18) !important; transition: outline .2s, box-shadow .2s; }
      .json-autofill-skipped { outline: 3px solid #f2b705 !important; box-shadow: 0 0 0 4px rgba(242, 183, 5, .18) !important; transition: outline .2s, box-shadow .2s; }
      #${PANEL_ID} { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px; width: min(380px, calc(100vw - 36px)); max-height: min(520px, calc(100vh - 36px)); overflow: auto; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #fff; border: 1px solid #d9e1ea; border-radius: 8px; box-shadow: 0 18px 48px rgba(20, 31, 44, .2); }
      #${PANEL_ID} header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #edf1f6; font-weight: 700; }
      #${PANEL_ID} button { border: 0; background: #eef3f8; color: #243447; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
      #${PANEL_ID} .jaf-body { padding: 12px 14px; }
      #${PANEL_ID} .jaf-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
      #${PANEL_ID} .jaf-stat { background: #f6f8fb; border-radius: 6px; padding: 8px; text-align: center; }
      #${PANEL_ID} .jaf-stat strong { display: block; font-size: 18px; }
      #${PANEL_ID} .jaf-list { margin: 8px 0 0; padding-left: 18px; }
      #${PANEL_ID} .jaf-muted { color: #667085; }
    `;
    document.documentElement.appendChild(style);
  }

  function allRoots(root = document) {
    const roots = [root];
    const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = treeWalker.nextNode();
    while (node) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      node = treeWalker.nextNode();
    }
    return roots;
  }

  function collectFields() {
    const fields = [];
    allRoots().forEach((root) => {
      root.querySelectorAll(FIELD_SELECTOR).forEach((element) => {
        if (Utils.isFillableElement(element) && isFormFieldCandidate(element)) fields.push(element);
      });
    });
    return fields;
  }

  function isFormFieldCandidate(element) {
    if (element.closest(`#${PANEL_ID}`)) return false;
    if (element.closest("aside, nav, header, footer, [role='navigation'], [class*='sidebar' i], [class*='side-nav' i]")) return false;
    const descriptorText = [
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute("aria-label"),
      Utils.labelForElement(element)
    ].join(" ");
    if (/\b(search|filter|menu|navigation|employer-?9035|pocs-?9035)\b/i.test(descriptorText)) return false;
    return true;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function visibleText(element) {
    return String(element?.innerText || element?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formSignature() {
    return collectFields()
      .slice(0, 24)
      .map((field) => Mapping.fieldSignature(field))
      .join(";");
  }

  function pageStepSignature() {
    const heading = visibleText(document.querySelector("h1, h2, [role='heading']"));
    return `${location.href}|${heading}|${formSignature()}`;
  }

  function looksLikeSectionControl(element) {
    if (!Utils.isVisible(element)) return false;
    if (element.closest(`#${PANEL_ID}`)) return false;
    if (element.matches(FIELD_SELECTOR)) return false;
    const text = visibleText(element);
    if (text.length < 2 || text.length > 180) return false;
    if (/^(previous|next|save|submit|cancel|close|help|settings)$/i.test(text)) return false;
    return /^[A-Z]\b/.test(text)
      || /^section\s+[A-Z0-9]/i.test(text)
      || /^part\s+[A-Z0-9]/i.test(text)
      || /\b(information|statements|attorney|employer|wage|temporary|worker|labor|contact)\b/i.test(text);
  }

  function discoverSectionControls() {
    const controls = [];
    const seen = new Set();
    document.querySelectorAll(SECTION_NAV_SELECTOR).forEach((element) => {
      const clickableAncestor = element.closest("a, button, [role='button'], [tabindex], li");
      const control = clickableAncestor && visibleText(clickableAncestor).length <= 180 ? clickableAncestor : element;
      if (!looksLikeSectionControl(control)) return;
      const rect = control.getBoundingClientRect();
      const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Utils.normalizeKey(visibleText(control)).slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      controls.push({
        element: control,
        label: visibleText(control),
        signature: Utils.normalizeKey(visibleText(control)).slice(0, 100),
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        active: control.getAttribute("aria-current") === "step"
          || control.getAttribute("aria-selected") === "true"
          || /\b(active|selected|current)\b/i.test(control.className || "")
      });
    });

    return controls
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .filter((item, index, list) => {
        return list.findIndex((candidate) => candidate.signature === item.signature) === index;
      });
  }

  function resolveSection(section) {
    return discoverSectionControls().find((candidate) => candidate.signature === section.signature) || section;
  }

  async function waitForSectionChange(previousSignature) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 2500) {
      await delay(120);
      if (pageStepSignature() !== previousSignature) return true;
    }
    return false;
  }

  function dispatchNavigationSafeClick(element) {
    const navigableAnchor = element.closest?.("a[href]");
    const cancelNativeNavigation = (event) => {
      if (navigableAnchor && (event.target === element || element.contains(event.target))) {
        event.preventDefault();
      }
    };

    window.addEventListener("click", cancelNativeNavigation, { once: true });
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  }

  async function activateSection(section) {
    section = resolveSection(section);
    const before = pageStepSignature();
    section.element.scrollIntoView({ block: "center", inline: "nearest" });
    dispatchNavigationSafeClick(section.element);
    await waitForSectionChange(before);
    await delay(250);
  }

  function findContinueControl() {
    return null;
  }

  async function continueToNextSection(settings) {
    const result = await JsonAutofillNavigation.navigate({
      domain: Utils.getDomain(),
      panelId: PANEL_ID,
      customSelectors: settings.navigationCustomSelectors,
      config: {
        maxRetries: Number(settings.navigationMaxRetries ?? 2),
        transitionTimeoutMs: Number(settings.navigationTimeoutMs ?? 3500)
      }
    });
    return result;
  }

  function dispatchFrameworkEvents(element) {
    ["beforeinput", "input", "change", "blur"].forEach((eventName) => {
      element.dispatchEvent(new Event(eventName, { bubbles: true, composed: true }));
    });
  }

  function setNativeValue(element, value) {
    const tag = element.tagName.toLowerCase();
    const prototype = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function normalizeOptionText(value) {
    return Utils.normalizeKey(String(value));
  }

  function valueAliases(value) {
    const raw = String(value ?? "").trim();
    const firstToken = raw.replace(/^\/+/, "").split(/[_\s-]/)[0];
    return Utils.unique([raw, firstToken, raw.replace(/^\/+/, ""), raw.replace(/_/g, " ")])
      .map(normalizeOptionText);
  }

  function fillSelect(select, value) {
    const values = Array.isArray(value) ? value.map(String) : String(value).split(",").map((item) => item.trim());
    const normalizedValues = new Set(values.flatMap(valueAliases));
    let changed = false;

    Array.from(select.options).forEach((option) => {
      const optionValue = normalizeOptionText(option.value);
      const optionText = normalizeOptionText(option.text);
      const optionMatches = normalizedValues.has(optionValue)
        || normalizedValues.has(optionText)
        || [...normalizedValues].some((candidate) => candidate && (optionText.includes(candidate) || candidate.includes(optionText)));
      if (select.multiple) {
        option.selected = optionMatches;
        changed = changed || optionMatches;
      } else if (optionMatches && !changed) {
        select.value = option.value;
        changed = true;
      }
    });

    if (!changed && !select.multiple) {
      select.value = String(value);
      changed = select.value === String(value);
    }

    return changed;
  }

  function fillCheckbox(element, value) {
    const desired = Array.isArray(value)
      ? value.flatMap(valueAliases).includes(normalizeOptionText(element.value || element.name))
      : Utils.coerceBoolean(value);
    element.checked = desired;
    return true;
  }

  function fillRadio(element, value) {
    const desiredValues = valueAliases(value);
    const group = element.name
      ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`))
      : [element];
    const target = group.find((radio) => desiredValues.includes(normalizeOptionText(radio.value)))
      || group.find((radio) => desiredValues.includes(normalizeOptionText(Utils.labelForElement(radio))));
    if (!target) return false;
    target.checked = true;
    dispatchFrameworkEvents(target);
    return true;
  }

  function fillFileInput(element, value) {
    return {
      ok: false,
      reason: `Browser security prevents setting file inputs automatically (${value || "no path supplied"}).`
    };
  }

  function formatForInput(element, value) {
    const type = (element.type || "").toLowerCase();
    if (value == null) return "";
    if (type === "date" && value instanceof Date) return value.toISOString().slice(0, 10);
    if (type === "date") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString().slice(0, 10);
    }
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function fillElement(element, value) {
    try {
      const type = (element.type || "").toLowerCase();
      const tag = element.tagName.toLowerCase();

      if (!Utils.isVisible(element) && type !== "hidden") {
        return { ok: false, reason: "Field is hidden or not visible." };
      }
      if (element.disabled || element.readOnly) {
        return { ok: false, reason: "Field is disabled or read-only." };
      }
      element.focus?.({ preventScroll: true });
      if (type === "file") return fillFileInput(element, value);
      if (type === "checkbox") {
        fillCheckbox(element, value);
      } else if (type === "radio") {
        const ok = fillRadio(element, value);
        if (!ok) return { ok: false, reason: "No radio option matched the JSON value." };
        return { ok: true };
      } else if (tag === "select") {
        const ok = fillSelect(element, value);
        if (!ok) return { ok: false, reason: "No select option matched the JSON value." };
      } else {
        setNativeValue(element, formatForInput(element, value));
      }

      dispatchFrameworkEvents(element);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  function highlight(element, className, enabled) {
    if (!enabled || !element?.classList) return;
    ensureStyle();
    element.classList.add(className);
    setTimeout(() => element.classList.remove(className), 2200);
  }

  function buildFieldOptions(fields) {
    return fields.map((field, index) => {
      const descriptor = Utils.elementDescriptor(field);
      return {
        index,
        label: descriptor.displayName || descriptor.selectorHint,
        selectorHint: descriptor.selectorHint,
        signature: Mapping.fieldSignature(field)
      };
    });
  }

  function showResultPanel(result) {
    ensureStyle();
    document.getElementById(PANEL_ID)?.remove();
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    const visibleSkipped = result.skipped.filter((item) => !item.ignored);
    const skippedItems = visibleSkipped.slice(0, 12).map((item) => `<li>${escapeHtml(item.key || item.field || "Unknown")}: <span class="jaf-muted">${escapeHtml(item.reason)}</span></li>`).join("");
    const errorItems = result.errors.slice(0, 8).map((item) => `<li>${escapeHtml(item.field || item.key || "Unknown")}: <span class="jaf-muted">${escapeHtml(item.reason)}</span></li>`).join("");
    panel.innerHTML = `
      <header><span>JSON Autofill Results</span><button type="button" aria-label="Close">Close</button></header>
      <div class="jaf-body">
        <div class="jaf-stats">
          <div class="jaf-stat"><strong>${result.filled.length}</strong>Filled</div>
          <div class="jaf-stat"><strong>${visibleSkipped.length}</strong>Skipped</div>
          <div class="jaf-stat"><strong>${result.errors.length}</strong>Errors</div>
          <div class="jaf-stat"><strong>${result.successRate}%</strong>Success</div>
        </div>
        ${skippedItems ? `<strong>Skipped fields</strong><ul class="jaf-list">${skippedItems}</ul>` : ""}
        ${errorItems ? `<strong>Errors</strong><ul class="jaf-list">${errorItems}</ul>` : ""}
      </div>
    `;
    panel.querySelector("button").addEventListener("click", () => panel.remove());
    document.documentElement.appendChild(panel);
    setTimeout(() => panel.remove(), 15000);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function autofillCurrentSection(context) {
    const { data, jsonKeys, settings, savedMappings, domain, usedKeys } = context;
    const fields = collectFields();
    const filled = [];
    const skipped = [];
    const errors = [];

    for (const field of fields) {
      const signature = Mapping.fieldSignature(field);
      const signals = Utils.getFieldSignals(field);
      const descriptor = Utils.elementDescriptor(field);
      const savedKey = savedMappings[signature];
      const match = savedKey && Object.prototype.hasOwnProperty.call(data, savedKey)
        ? { key: savedKey, score: 1, source: "saved mapping" }
        : { ...Mapping.bestJsonKeyForField(jsonKeys, signals, { strict: settings.strictMatching }), source: "auto" };

      if (!match.key) {
        skipped.push({ field: descriptor.displayName, signature, reason: "No matching JSON key found.", options: buildFieldOptions([field]) });
        highlight(field, "json-autofill-skipped", settings.highlightFields);
        continue;
      }

      if (data[match.key] === "" || data[match.key] === null || data[match.key] === undefined) {
        skipped.push({ field: descriptor.displayName, key: match.key, signature, reason: "JSON value is empty.", ignored: true });
        continue;
      }

      const fillResult = fillElement(field, data[match.key]);
      if (fillResult.ok) {
        usedKeys.add(match.key);
        filled.push({ field: descriptor.displayName, key: match.key, score: match.score, source: match.source, signature });
        highlight(field, "json-autofill-filled", settings.highlightFields);
      } else {
        errors.push({ field: descriptor.displayName, key: match.key, signature, reason: fillResult.reason });
        highlight(field, "json-autofill-skipped", settings.highlightFields);
      }
    }

    return { filled, skipped, errors, availableFields: buildFieldOptions(fields), sectionCount: 1 };
  }

  function mergeSectionResult(target, source, sectionLabel) {
    ["filled", "skipped", "errors", "availableFields"].forEach((key) => {
      const values = source[key] || [];
      values.forEach((item) => target[key].push(sectionLabel ? { ...item, section: sectionLabel } : item));
    });
    target.sectionCount += source.sectionCount || 0;
  }

  async function autofill(payload, options = {}) {
    const startedAt = performance.now();
    const settings = { ...Utils.DEFAULT_SETTINGS, ...(options.settings || {}) };
    const data = settings.autoFlatten ? Utils.flattenJson(payload || {}) : payload || {};
    const jsonKeys = Object.keys(data);
    const domain = Utils.getDomain();
    const savedMappings = settings.saveMappings ? await Mapping.loadDomainMappings(domain) : {};
    const usedKeys = new Set();
    const aggregate = {
      filled: [],
      skipped: [],
      errors: [],
      availableFields: [],
      sectionCount: 0
    };
    const context = { data, jsonKeys, settings, savedMappings, domain, usedKeys };
    const sections = settings.fillAllSections ? discoverSectionControls() : [];
    const originalSection = sections.find((section) => section.active) || null;

    if (settings.fillAllSections && settings.useContinueFlow && sections.length > 1) {
      const firstSection = sections[0];
      if (firstSection && !firstSection.active) await activateSection(firstSection);

      const visitedSteps = new Set();
      const maxSteps = Math.max(sections.length + 4, 12);
      for (let step = 0; step < maxSteps; step += 1) {
        const signature = pageStepSignature();
        if (visitedSteps.has(signature)) break;
        visitedSteps.add(signature);

        const currentSection = discoverSectionControls().find((section) => section.active);
        const sectionResult = await autofillCurrentSection(context);
        mergeSectionResult(aggregate, sectionResult, currentSection?.label || visibleText(document.querySelector("h1, h2")) || `Step ${step + 1}`);

        const navigation = await continueToNextSection(settings);
        if (!navigation.ok) {
          aggregate.errors.push({
            field: "Navigation",
            section: currentSection?.label || `Step ${step + 1}`,
            reason: navigation.reason || "Navigation failed.",
            details: navigation.missing?.join(", ") || navigation.attemptedControl?.label || ""
          });
          break;
        }
      }
    } else if (sections.length > 1) {
      for (const section of sections) {
        const currentSection = resolveSection(section);
        if (!document.documentElement.contains(currentSection.element)) continue;
        await activateSection(currentSection);
        const sectionResult = await autofillCurrentSection(context);
        mergeSectionResult(aggregate, sectionResult, currentSection.label);
      }

      if (settings.returnToOriginalSection && originalSection) {
        const currentOriginal = resolveSection(originalSection);
        if (document.documentElement.contains(currentOriginal.element)) await activateSection(currentOriginal);
      }
    } else {
      mergeSectionResult(aggregate, await autofillCurrentSection(context), "");
    }

    jsonKeys.forEach((key) => {
      if (!usedKeys.has(key)) aggregate.skipped.push({ key, reason: "No compatible page field matched this JSON key." });
    });

    const reportableSkipped = aggregate.skipped.filter((item) => !item.ignored);
    const attempted = aggregate.filled.length + reportableSkipped.length + aggregate.errors.length;
    const result = {
      filled: aggregate.filled,
      skipped: aggregate.skipped,
      errors: aggregate.errors,
      availableFields: aggregate.availableFields,
      jsonKeys,
      sectionCount: aggregate.sectionCount,
      successRate: attempted ? Math.round((aggregate.filled.length / attempted) * 100) : 0,
      durationMs: Math.round(performance.now() - startedAt)
    };

    await chrome.storage.local.set({ [Utils.STORAGE_KEYS.lastResult]: result });
    showResultPanel(result);
    return result;
  }

  function setupDynamicObserver() {
    if (observer) return;
    observer = new MutationObserver(Utils.debounce(async () => {
      if (!pendingAutoFill || !lastPayload) return;
      pendingAutoFill = false;
      const { [Utils.STORAGE_KEYS.settings]: settings = Utils.DEFAULT_SETTINGS } = await chrome.storage.local.get(Utils.STORAGE_KEYS.settings);
      if (settings.autoFillOnPageLoad) await autofill(lastPayload, { settings });
    }, 500));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "AUTOFILL_JSON") {
      lastPayload = message.payload;
      autofill(message.payload, { settings: message.settings })
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "SCAN_FIELDS") {
      sendResponse({ ok: true, fields: buildFieldOptions(collectFields()) });
      return false;
    }

    if (message.type === "ENABLE_AUTO_FILL_OBSERVER") {
      lastPayload = message.payload;
      pendingAutoFill = true;
      setupDynamicObserver();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  setupDynamicObserver();
})();
