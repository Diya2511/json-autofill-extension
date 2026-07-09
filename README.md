# JSON Autofill Pro

JSON Autofill Pro is a Manifest V3 Chrome extension that imports a JSON file, detects compatible form fields on the active page, fills them, dispatches framework-friendly events, and reports what worked.

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `json-autofill-extension` folder.
5. Pin **JSON Autofill Pro** from the extensions menu.

## Usage

1. Open any web application form.
2. Click the extension icon.
3. Click **Import JSON** and choose a `.json` file.
4. Click **Autofill**.
5. Review the result panel on the page and the popup summary.
6. If JSON keys could not be matched, use the mapping section in the popup to connect a JSON key to a detected page field, then click **Save**.

The keyboard shortcut `Ctrl + Shift + F` runs autofill using the last imported JSON. On macOS, use `Command + Shift + F`.

## Example JSON

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "9999999999",
  "address": {
    "street": "ABC Road",
    "city": "Hyderabad",
    "state": "Telangana"
  }
}
```

Nested objects are flattened by default, so `address.city` becomes a fillable key with the value `Hyderabad`.

## Project Structure

```text
json-autofill-extension/
  manifest.json       Extension metadata, permissions, shortcut, and service worker
  popup.html          Popup layout
  popup.css           Popup styling
  popup.js            JSON import, settings, result rendering, mapping import/export
  content.js          Page scanning, matching orchestration, fill logic, highlights, result panel
  utils.js            Shared helpers for flattening, normalization, DOM field signals, storage
  mapping.js          Synonyms, scoring, and domain-specific mapping persistence
  background.js       Script injection, shortcut handling, active-tab messaging
  icons/              Extension icons
```

## Field Detection

The matcher scores fields using these signals:

1. `name`
2. `id`
3. `placeholder`
4. `aria-label`
5. label text
6. `autocomplete`
7. `data-*` attributes
8. nearest label or legend text
9. nearby visible text

Open shadow roots are scanned when available. Closed shadow roots cannot be inspected by browser extensions.

## Supported Controls

The extension supports text-like inputs, `textarea`, `select`, multi-select, checkbox, radio, date, number, email, tel, password, and file fields. Browsers do not allow extensions to programmatically set file input paths for security reasons, so file fields are reported as skipped with a clear message.

After setting a value, the extension dispatches bubbling `input`, `change`, and `blur` events so React, Angular, Vue, ASP.NET, and similar frameworks can detect updates.

## Custom Matching Rules

Edit `mapping.js` and add aliases to `CANONICAL_SYNONYMS`.

```js
const CANONICAL_SYNONYMS = {
  firstName: ["first name", "given name", "fname"],
  employeeId: ["employee id", "staff id", "worker number"]
};
```

Use a stable canonical key such as `employeeId`, then include real labels, placeholders, or field names you see in your application.

## Extending Field Detection

Field signals are collected in `getFieldSignals` inside `utils.js`. Add new attributes or page-specific hints there if your application uses custom markers.

For example:

```js
element.getAttribute("data-field-key")
```

The content script will automatically include the new signal in future scoring.

## Settings

- **Highlight fields**: briefly outlines filled fields in green and skipped fields in yellow.
- **Auto flatten JSON**: converts nested JSON into dot paths.
- **Save mappings**: persists manual mappings in `chrome.storage.local`.
- **Auto fill on page load**: refills pages after navigation when a JSON file has already been imported.
- **Fill all sections**: detects sidebar, wizard, and step navigation items, clicks through each section, and fills fields as they are rendered.
- **Use Continue flow**: fills a section, uses the navigation engine to find the best forward control, verifies the transition, and then continues.
- **Return to original section**: after scanning all sections, navigates back to the section that was active when autofill started.
- **Strict matching**: requires stronger name matches and avoids fuzzy token matching.
- **AI matching**: reserved as an offline toggle for teams that want to add their own matching service later. No remote requests are made by this extension.

## Navigation Engine

The multi-step navigation engine is implemented in `navigation.js`. It does not rely on a single button label. It scores candidate controls using visible text, `id`, `name`, class names, ARIA labels, titles, `data-*` attributes, control type, position in the form, custom selectors, and learned selectors saved per domain.

Recognized forward actions include `Next`, `Continue`, `Save & Continue`, `Save and Next`, `Proceed`, `Review`, and similar application-specific controls. Add custom selectors in the popup settings when an application uses unique controls.

After every click, the engine verifies that navigation actually happened by checking for URL changes, heading changes, visible field changes, progress changes, or meaningful DOM updates. If no transition is verified after the configured retries, automation pauses and reports the failure.

## Mapping Import and Export

Mappings are domain-specific. The popup can export a JSON file like this:

```json
{
  "domain": "example.com",
  "mappings": {
    "name:applicantfirstname": "firstName"
  }
}
```

Importing a mapping file applies it to the current active domain.

## Troubleshooting

- **Nothing fills**: make sure the active tab is a normal `http`, `https`, or `file` page. Chrome blocks injection on internal pages such as `chrome://extensions`.
- **Some fields are skipped**: the field may be hidden, disabled, read-only, or a file input.
- **Only one section fills**: enable **Fill all sections** in the popup. The extension can fill sections that are reachable through visible sidebar, wizard, or step navigation items.
- **React or Angular does not detect a value**: the extension uses native setters plus `input`, `change`, and `blur` events. If a custom component still ignores updates, add a manual mapping and rerun autofill.
- **Dynamic fields appear late**: enable **Auto fill on page load** or click **Autofill** again after the page finishes rendering.
- **Shortcut does not work**: go to `chrome://extensions/shortcuts` and confirm `Ctrl + Shift + F` is assigned to JSON Autofill Pro.

## Performance

The scanner uses a single pass over fillable controls and precomputed normalized JSON keys. Filling 100 ordinary fields should complete comfortably under two seconds on typical web applications.
