# In-Page Translator

Translate web pages in place in Chrome and Helium. The extension translates text as it comes into view and keeps it translated as you scroll. **Show original** restores the text without reloading the page.

## Install

Use desktop Chrome 138 or later, or a compatible Chromium-based browser such as Helium. The ZIP is ready to load. No build tools or account required.

1. [Download the latest extension ZIP](https://github.com/mhdsdt/in-page-translator/releases/latest/download/in-page-translator.zip) and extract it to a folder you can keep.
2. Open `chrome://extensions` (or `helium://extensions` in Helium) and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder that contains `manifest.json`.
4. Open a web page and choose **In-Page Translator** from your browser’s Extensions menu. You can pin it to the toolbar there.

To update, download the latest ZIP, replace the contents of the installed folder, and click **Reload** on the extension card. Using the same folder keeps your downloaded packs. Updates are manual.

## Translate a page

1. Open **In-Page Translator** (or press `Alt+Shift+T`) and choose **From** and **To** (use the swap button to reverse them). The extension can detect the source language.
2. If the language pair is not yet installed, click **Download & translate** to download the pack directly in the popup and automatically translate the page once it finishes.
3. Otherwise click **Translate page**. The toolbar badge shows the active target language; select **Show original** (or press `Alt+Shift+T` again) to restore the page.

The first download for a language pair needs an internet connection. Installed pairs work offline. Open **Packs** to see available languages, check download and disk sizes, and remove packs. When a direct model is unavailable, the extension can use two available packs to translate through English.

## Coverage and privacy

- The extension translates inline markup (such as links, bold, emphasis, and inline code) as coherent whole sentences while keeping live DOM nodes, links, and event listeners intact, and preserves editable content, form values, code, and translation opt-outs. Eligible labels and CSS pseudo-element `data-*` text are translated with their visible element. Visibility uses viewport clipping and CSS visibility, including inside same-origin frames. Open shadow roots can be discovered after the initial scan. A partially visible text node is translated as a unit.
- Cross-origin frames, closed shadow roots, and text baked into images or canvas are outside its reach. Browser-internal pages and the Chrome Web Store restrict extension access. File pages require file access in the extension’s settings.
- The extension contacts Mozilla’s public model bucket when you download a pack. Page text stays on your device. Original text for restoration stays in the page script’s memory. Downloaded packs live in the extension’s IndexedDB storage and the extension remembers the last target language.

## Development

Use Node.js 22 or later to build from source.

```sh
npm ci
npm run build
```

Load the resulting `dist` folder using the steps above. To run the test suites, install Playwright’s Chromium first.

```sh
npx playwright install chromium
npm run check
npm run test:packs
```

`npm run check` type-checks, builds, and runs deterministic Chrome extension regression tests. `npm run test:packs` needs an internet connection and verifies that a fresh profile can install verified Mozilla packs, reload them from storage, translate through English, and remove packs. Set `PACKS_BROWSER_BIN` to an installed Helium executable to run that test in Helium.

`npm run models:refresh` explicitly updates the pinned catalog from Mozilla’s released desktop models. Builds use that checked-in catalog. Model files are fetched only when a pack is installed, and each download’s length and decoded file’s SHA-256 digest are checked against the catalog. See [third-party notices](static/THIRD-PARTY-NOTICES.md).

The isolated page script discovers and patches text. The popup owns tab controls and the manager owns pack selection. The offscreen extension document coordinates downloads, IndexedDB, and a shared LRU cache, and runs Bergamot inference across a dynamic worker pool. Inference work is length-bucketed and batched by route; the primary worker holds the active route’s models for three idle minutes while burst workers retire after 45 idle seconds.

## Contribute

Bug reports and pull requests are welcome. For a bug report, include the browser and extension versions, the language pair, and the steps to reproduce it. Use a public example page or sample text. [Open an issue](https://github.com/mhdsdt/in-page-translator/issues/new).

## License

The extension’s original code and assets are under the [MIT License](LICENSE). Bergamot and the downloadable Mozilla models are under [MPL 2.0](static/MPL-2.0.txt). See the [third-party notices](static/THIRD-PARTY-NOTICES.md) for source links.
