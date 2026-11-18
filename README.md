# In-Page Translator

Translate text as it enters the viewport, including inside scrollable panels and same-origin frames. Previously viewed text stays translated when you scroll away. **Show original** restores the text without reloading the page.

## Install in Chrome or Helium

1. Open `chrome://extensions` or `helium://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this project’s `dist` directory. If you cloned the source, run `npm ci` and `npm run build` first.
3. Open a web page and click the extension. Choose **From** and **To**. **From** can use the page’s declaration or the browser’s language detection.
4. Click **Get language packs** when a pair is missing, then **Download packs**. Use **Back to page** and reopen the extension to click **Translate page**. Installed pairs work offline.

The pack manager displays the download and disk sizes and lets you remove installed packs. A new installation starts with an empty pack list. When there is no direct model, supported pairs can translate through English and reuse the two installed packs.

## Coverage and privacy

- The extension preserves editable content, form values, code, and translation opt-outs. Eligible labels are translated with their visible element. Visibility uses viewport clipping and CSS visibility, including inside same-origin frames. Open shadow roots can be discovered after the initial scan. A partially visible text node is translated as a unit.
- Cross-origin frames, closed shadow roots, and text baked into images or canvas are outside its reach. Browser-internal pages and the Chrome Web Store restrict extension access. File pages require file access in the extension’s settings.
- Only pack files are downloaded from Mozilla’s public model bucket. Page text stays on the device. Original text for restoration stays in the page script’s memory. Downloaded packs live in the extension’s IndexedDB storage and the extension remembers the last target language.

## Development

Use Node.js 22 or later.

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:packs
```

`npm run check` type-checks, builds, and runs deterministic Chrome extension regression tests. `npm run test:packs` needs an internet connection and verifies that a fresh profile can install verified Mozilla packs, reload them from storage, translate through English, and remove packs. Set `PACKS_BROWSER_BIN` to an installed Helium executable to run that test in Helium.

`npm run models:refresh` explicitly updates the pinned catalog from Mozilla’s released desktop models. Builds use that checked-in catalog. Model files are fetched only when a pack is installed, and each download’s length and decoded file’s SHA-256 digest are checked against the catalog. See [third-party notices](static/THIRD-PARTY-NOTICES.md).

The isolated page script discovers and patches text. The popup owns tab controls and the manager owns pack selection. The offscreen extension document coordinates downloads and IndexedDB, and runs Bergamot inference in a worker. Inference work is batched by route. The worker holds the active route’s models and releases them after two idle minutes.
