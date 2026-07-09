/* Shared helpers for JSON flattening, text normalization, DOM inspection, and safe messaging. */

const JsonAutofillUtils = (() => {
  const DEFAULT_SETTINGS = Object.freeze({
    highlightFields: true,
    autoFlatten: true,
    saveMappings: true,
    autoFillOnPageLoad: false,
    fillAllSections: true,
    useContinueFlow: true,
    returnToOriginalSection: false,
    navigationCustomSelectors: "",
    navigationMaxRetries: 2,
    navigationTimeoutMs: 3500,
    strictMatching: false,
    aiMatching: false
  });

  const STORAGE_KEYS = Object.freeze({
    jsonPayload: "jsonAutofill:lastJsonPayload",
    jsonFileName: "jsonAutofill:lastJsonFileName",
    settings: "jsonAutofill:settings",
    mappings: "jsonAutofill:mappings",
    navigationMappings: "jsonAutofill:navigationMappings",
    lastResult: "jsonAutofill:lastResult"
  });

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function flattenJson(input, options = {}) {
    const delimiter = options.delimiter || ".";
    const includeArrays = options.includeArrays !== false;
    const output = {};

    function visit(value, path) {
      if (Array.isArray(value)) {
        if (!includeArrays) {
          output[path] = value;
          return;
        }
        if (value.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
          output[path] = value;
          return;
        }
        value.forEach((item, index) => visit(item, path ? `${path}${delimiter}${index}` : String(index)));
        return;
      }

      if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (!entries.length && path) output[path] = "";
        entries.forEach(([key, child]) => {
          const nextPath = path ? `${path}${delimiter}${key}` : key;
          visit(child, nextPath);
        });
        return;
      }

      output[path] = value == null ? "" : value;
    }

    visit(input, "");
    return output;
  }

  function splitWords(text) {
    return String(text || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-./:[\](){}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeKey(text) {
    return splitWords(text)
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, "");
  }

  function tokenize(text) {
    const normalized = splitWords(text).replace(/[^a-z0-9 ]/g, " ");
    return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  }

  function unique(values) {
    return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).trim() !== ""))];
  }

  function labelForElement(element) {
    if (!element) return "";
    const labels = [];
    if (element.id) {
      document.querySelectorAll(`label[for="${CSS.escape(element.id)}"]`).forEach((label) => labels.push(label.innerText));
    }
    if (element.labels) {
      Array.from(element.labels).forEach((label) => labels.push(label.innerText));
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.innerText);
    return unique(labels).join(" ");
  }

  function nearestText(element) {
    const textParts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const label = current.querySelector?.("label");
      if (label) textParts.push(label.innerText);
      const legend = current.querySelector?.("legend");
      if (legend) textParts.push(legend.innerText);
      const previous = current.previousElementSibling;
      if (previous && previous.innerText && previous.innerText.length < 160) textParts.push(previous.innerText);
      current = current.parentElement;
    }
    return unique(textParts).join(" ");
  }

  function dataAttributeText(element) {
    return Object.entries(element.dataset || {})
      .map(([key, value]) => `${key} ${value}`)
      .join(" ");
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isFillableElement(element) {
    if (!element || element.disabled || element.readOnly) return false;
    const tag = element.tagName?.toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return false;
    const type = (element.type || "").toLowerCase();
    return !["button", "submit", "reset", "image", "hidden"].includes(type);
  }

  function elementDescriptor(element) {
    const tag = element.tagName.toLowerCase();
    const type = element.type ? `:${element.type}` : "";
    const name = element.name ? `[name="${element.name}"]` : "";
    const id = element.id ? `#${element.id}` : "";
    const label = labelForElement(element) || element.getAttribute("aria-label") || element.placeholder || element.name || element.id || tag;
    return {
      tag,
      type: element.type || tag,
      displayName: String(label).replace(/\s+/g, " ").trim().slice(0, 120),
      selectorHint: `${tag}${type}${id}${name}`
    };
  }

  function getFieldSignals(element) {
    const describedBy = element.getAttribute("aria-describedby");
    const describedText = describedBy
      ? describedBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ")
      : "";

    return unique([
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute("aria-label"),
      labelForElement(element),
      element.autocomplete,
      dataAttributeText(element),
      nearestText(element),
      describedText,
      element.getAttribute("title"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-test"),
      element.getAttribute("data-cy")
    ]);
  }

  function debounce(callback, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), wait);
    };
  }

  function getDomain(url = location.href) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "unknown-domain";
    }
  }

  function safeJsonParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function coerceBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const normalized = String(value).trim().toLowerCase().replace(/^\/+/, "").split(/[_\s-]/)[0];
    return ["true", "yes", "1", "on", "checked"].includes(normalized);
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(values) {
    return chrome.storage.local.set(values);
  }

  return {
    DEFAULT_SETTINGS,
    STORAGE_KEYS,
    flattenJson,
    splitWords,
    normalizeKey,
    tokenize,
    unique,
    labelForElement,
    nearestText,
    dataAttributeText,
    isVisible,
    isFillableElement,
    elementDescriptor,
    getFieldSignals,
    debounce,
    getDomain,
    safeJsonParse,
    coerceBoolean,
    storageGet,
    storageSet
  };
})();
