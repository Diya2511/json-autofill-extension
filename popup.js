/* Popup controller: imports JSON, runs autofill, manages settings and saved mappings. */

const Utils = JsonAutofillUtils;
const Mapping = JsonAutofillMapping;
const STORAGE = Utils.STORAGE_KEYS;

const state = {
  payload: null,
  flattened: {},
  fileName: "",
  settings: { ...Utils.DEFAULT_SETTINGS },
  lastResult: null,
  domain: ""
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  jsonInput: $("#jsonInput"),
  importJson: $("#importJson"),
  autofill: $("#autofill"),
  clearMapping: $("#clearMapping"),
  exportMapping: $("#exportMapping"),
  importMapping: $("#importMapping"),
  mappingInput: $("#mappingInput"),
  settingsToggle: $("#settingsToggle"),
  settingsPanel: $("#settingsPanel"),
  navigationCustomSelectors: $("#navigationCustomSelectors"),
  navigationMaxRetries: $("#navigationMaxRetries"),
  navigationTimeoutMs: $("#navigationTimeoutMs"),
  statusText: $("#statusText"),
  fileName: $("#fileName"),
  keyCount: $("#keyCount"),
  results: $("#results"),
  filledCount: $("#filledCount"),
  skippedCount: $("#skippedCount"),
  errorCount: $("#errorCount"),
  successRate: $("#successRate"),
  duration: $("#duration"),
  sectionCount: $("#sectionCount"),
  skippedList: $("#skippedList"),
  mappingPanel: $("#mappingPanel"),
  mappingRows: $("#mappingRows"),
  saveMappings: $("#saveMappings")
};

function setStatus(message, kind = "") {
  elements.statusText.textContent = message;
  elements.statusText.className = kind;
}

function updateJsonSummary() {
  state.flattened = state.payload ? Utils.flattenJson(state.payload) : {};
  const count = Object.keys(state.flattened).length;
  elements.fileName.textContent = state.fileName || "No file selected";
  elements.keyCount.textContent = `${count} ${count === 1 ? "key" : "keys"}`;
  elements.autofill.disabled = !state.payload;
}

function renderSettings() {
  elements.settingsPanel.querySelectorAll("[data-setting]").forEach((checkbox) => {
    checkbox.checked = Boolean(state.settings[checkbox.dataset.setting]);
  });
  elements.navigationCustomSelectors.value = state.settings.navigationCustomSelectors || "";
  elements.navigationMaxRetries.value = state.settings.navigationMaxRetries ?? 2;
  elements.navigationTimeoutMs.value = state.settings.navigationTimeoutMs ?? 3500;
}

async function saveSettings() {
  await chrome.storage.local.set({ [STORAGE.settings]: state.settings });
}

async function getActiveDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Utils.getDomain(tab?.url || "");
}

async function loadState() {
  const data = await chrome.storage.local.get([STORAGE.jsonPayload, STORAGE.jsonFileName, STORAGE.settings, STORAGE.lastResult]);
  state.payload = data[STORAGE.jsonPayload] || null;
  state.fileName = data[STORAGE.jsonFileName] || "";
  state.settings = { ...Utils.DEFAULT_SETTINGS, ...(data[STORAGE.settings] || {}) };
  state.lastResult = data[STORAGE.lastResult] || null;
  state.domain = await getActiveDomain();
  updateJsonSummary();
  renderSettings();
  if (state.payload) setStatus("Ready to autofill this page.", "success");
  if (state.lastResult) renderResult(state.lastResult);
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importJsonFile(file) {
  if (!file) return;
  const text = await readFileAsText(file);
  const parsed = Utils.safeJsonParse(text);
  if (!parsed.ok) {
    setStatus(`Invalid JSON: ${parsed.error}`, "error");
    return;
  }
  state.payload = parsed.value;
  state.fileName = file.name;
  await chrome.storage.local.set({
    [STORAGE.jsonPayload]: state.payload,
    [STORAGE.jsonFileName]: state.fileName
  });
  updateJsonSummary();
  setStatus("JSON imported successfully.", "success");
}

async function sendToActiveTab(message) {
  const response = await chrome.runtime.sendMessage({ type: "SEND_TO_ACTIVE_TAB", message });
  if (!response?.ok) throw new Error(response?.error || "Unable to communicate with the active tab.");
  return response.response;
}

async function runAutofill() {
  if (!state.payload) {
    setStatus("Import a JSON file first.", "error");
    return;
  }
  elements.autofill.disabled = true;
  setStatus("Filling fields...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "RUN_AUTOFILL" });
    if (!response?.ok) throw new Error(response?.error || "Autofill failed.");
    const result = response.response?.result || response.response;
    state.lastResult = result;
    renderResult(result);
    setStatus(`Autofill complete: ${result.filled.length} fields filled.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.autofill.disabled = false;
  }
}

function renderResult(result) {
  if (!result) return;
  elements.results.classList.remove("hidden");
  const visibleSkipped = (result.skipped || []).filter((item) => !item.ignored);
  elements.filledCount.textContent = result.filled?.length || 0;
  elements.skippedCount.textContent = visibleSkipped.length;
  elements.errorCount.textContent = result.errors?.length || 0;
  elements.successRate.textContent = `${result.successRate || 0}%`;
  elements.duration.textContent = `Completed in ${result.durationMs || 0} ms.`;
  elements.sectionCount.textContent = result.sectionCount > 1 ? `Scanned ${result.sectionCount} sections.` : "";

  const skipped = visibleSkipped.slice(0, 10);
  elements.skippedList.innerHTML = skipped.map((item) => `
    <div class="list-item"><strong>${escapeHtml(item.key || item.field || "Unmatched")}</strong>${item.section ? ` <span>${escapeHtml(item.section)}</span>` : ""}<br>${escapeHtml(item.reason || "")}</div>
  `).join("");
  renderMappingRows(result);
}

function renderMappingRows(result) {
  const jsonKeys = result.jsonKeys || Object.keys(state.flattened);
  const fields = result.availableFields || [];
  const unmatchedKeys = (result.skipped || [])
    .filter((item) => item.key && item.reason?.includes("No compatible"))
    .map((item) => item.key);

  if (!unmatchedKeys.length || !fields.length) {
    elements.mappingPanel.classList.add("hidden");
    elements.mappingRows.innerHTML = "";
    return;
  }

  elements.mappingPanel.classList.remove("hidden");
  elements.mappingRows.innerHTML = unmatchedKeys.map((key) => `
    <div class="mapping-row">
      <label>${escapeHtml(key)}</label>
      <select data-json-key="${escapeHtml(key)}">
        <option value="">Choose a page field</option>
        ${fields.map((field) => `<option value="${escapeHtml(field.signature)}">${escapeHtml(field.label)} - ${escapeHtml(field.selectorHint)}</option>`).join("")}
      </select>
    </div>
  `).join("");

  if (!jsonKeys.length) elements.mappingPanel.classList.add("hidden");
}

async function saveMappingRows() {
  const rows = Array.from(elements.mappingRows.querySelectorAll("select"));
  const mappings = {};
  rows.forEach((select) => {
    if (select.value) mappings[select.value] = select.dataset.jsonKey;
  });
  if (!Object.keys(mappings).length) {
    setStatus("Choose at least one mapping to save.", "error");
    return;
  }
  const existing = await Mapping.loadDomainMappings(state.domain);
  await Mapping.replaceDomainMappings(state.domain, { ...existing, ...mappings });
  setStatus("Mappings saved for this domain.", "success");
}

async function clearMappings() {
  await Mapping.clearDomainMappings(state.domain);
  setStatus("Mappings cleared for this domain.", "success");
}

async function exportMappings() {
  const mappings = await Mapping.loadDomainMappings(state.domain);
  const blob = new Blob([JSON.stringify({ domain: state.domain, mappings }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `json-autofill-mapping-${state.domain || "domain"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("Mapping exported.", "success");
}

async function importMappingFile(file) {
  if (!file) return;
  const text = await readFileAsText(file);
  const parsed = Utils.safeJsonParse(text);
  if (!parsed.ok || !parsed.value?.mappings) {
    setStatus("Mapping file must contain a mappings object.", "error");
    return;
  }
  await Mapping.replaceDomainMappings(state.domain, parsed.value.mappings);
  setStatus("Mapping imported for this domain.", "success");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

elements.importJson.addEventListener("click", () => elements.jsonInput.click());
elements.jsonInput.addEventListener("change", (event) => importJsonFile(event.target.files[0]));
elements.autofill.addEventListener("click", runAutofill);
elements.clearMapping.addEventListener("click", clearMappings);
elements.exportMapping.addEventListener("click", exportMappings);
elements.importMapping.addEventListener("click", () => elements.mappingInput.click());
elements.mappingInput.addEventListener("change", (event) => importMappingFile(event.target.files[0]));
elements.saveMappings.addEventListener("click", saveMappingRows);
elements.settingsToggle.addEventListener("click", () => elements.settingsPanel.classList.toggle("hidden"));

elements.settingsPanel.addEventListener("change", async (event) => {
  const setting = event.target?.dataset?.setting;
  if (setting) state.settings[setting] = event.target.checked;
  if (event.target === elements.navigationMaxRetries) state.settings.navigationMaxRetries = Number(event.target.value || 2);
  if (event.target === elements.navigationTimeoutMs) state.settings.navigationTimeoutMs = Number(event.target.value || 3500);
  await saveSettings();
  setStatus("Settings saved.", "success");
});

elements.navigationCustomSelectors.addEventListener("input", async () => {
  state.settings.navigationCustomSelectors = elements.navigationCustomSelectors.value;
  await saveSettings();
  setStatus("Navigation selectors saved.", "success");
});

document.addEventListener("DOMContentLoaded", loadState);
