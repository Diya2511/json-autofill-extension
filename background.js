/* Service worker: injects scripts, handles shortcut autofill, and keeps popup communication tidy. */

const SCRIPT_FILES = ["utils.js", "mapping.js", "navigation.js", "content.js"];
const STORAGE_KEYS = {
  jsonPayload: "jsonAutofill:lastJsonPayload",
  jsonFileName: "jsonAutofill:lastJsonFileName",
  settings: "jsonAutofill:settings"
};

const DEFAULT_SETTINGS = {
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
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function canInject(tab) {
  return tab?.id && /^https?:|^file:/.test(tab.url || "");
}

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: SCRIPT_FILES });
  }
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!canInject(tab)) throw new Error("Open a regular web page before using JSON Autofill Pro.");
  await ensureContentScripts(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

async function runAutofillFromStorage() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.jsonPayload, STORAGE_KEYS.settings]);
  const payload = data[STORAGE_KEYS.jsonPayload];
  if (!payload) throw new Error("Import a JSON file before running autofill.");
  return sendToActiveTab({
    type: "AUTOFILL_JSON",
    payload,
    settings: { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) }
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "autofill-current-page") return;
  runAutofillFromStorage().catch((error) => {
    chrome.storage.local.set({ "jsonAutofill:lastShortcutError": error.message });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "RUN_AUTOFILL") {
    runAutofillFromStorage()
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SEND_TO_ACTIVE_TAB") {
    sendToActiveTab(message.message)
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !canInject(tab)) return;
  const data = await chrome.storage.local.get([STORAGE_KEYS.jsonPayload, STORAGE_KEYS.settings]);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
  if (!settings.autoFillOnPageLoad || !data[STORAGE_KEYS.jsonPayload]) return;
  try {
    await ensureContentScripts(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "ENABLE_AUTO_FILL_OBSERVER",
      payload: data[STORAGE_KEYS.jsonPayload]
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "AUTOFILL_JSON",
      payload: data[STORAGE_KEYS.jsonPayload],
      settings
    });
  } catch {
    // Some Chrome pages and protected frames do not allow injection.
  }
});
