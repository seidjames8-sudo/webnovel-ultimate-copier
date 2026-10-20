# WebNovel Ultimate Chapter Copier

A Chrome and Microsoft Edge extension (Manifest V3) that copies a full WebNovel chapter with one click or a keyboard shortcut, and can auto-copy each next chapter you open.

Chapter text is processed locally. Nothing is sent to any server.

## Status of this package

| Part | Status |
| --- | --- |
| Extension (manifest, popup, content script, background, offscreen) | Complete. Syntax checked. |
| JavaScript fallback text engine (`js-fallback-engine.js`) | Complete. 20 Node tests pass (`npm run test:js`). |
| Rust text engine (`rust-engine/src/lib.rs`) | Complete source with unit tests. **Not compiled or tested in the package build environment.** Run `npm run test:rust` to verify. |
| WASM artifacts (`wasm/text_engine.js`, `wasm/text_engine_bg.wasm`) | **Not included.** Generate them with `npm run build:wasm`. |

The extension works without the WASM artifacts. If they are missing or fail the self-test, the JavaScript fallback is used, and the popup shows which engine is active. Build the WASM engine to use the Rust version.

## Architecture

```
 webpage ── content.js ── (paragraphs, title, stats) ──┐
   DOM extraction, navigation watcher,                  │
   Auto-Copy, Ctrl+A, Copy Now panel                    ▼
                                                 background.js
 popup.js ── messages ─────────────────────────►  shortcuts, relay,
   controls, preview, settings                    custom site registration
                                                        │
                                                        ▼
                                                 offscreen.html / offscreen.js
                                                   engine-loader.js
                                                     ├─ wasm/text_engine.js (Rust/WASM)
                                                     └─ js-fallback-engine.js (JS mirror)
                                                   normalize → validate → clipboard write
```

**JavaScript** handles everything that needs a browser API: reading the DOM, detecting navigation, storage, messaging, the popup, notifications, and the clipboard write itself.

**Rust/WASM** handles pure text logic: `normalize_chapter_text`, `count_characters`, `count_paragraphs`, `validate_chapter_text`, and `get_text_statistics`. It never touches the DOM, network, or clipboard.

Every copy goes through the engine before it reaches the clipboard. This means the text is normalized and validated even when Auto-Copy runs in the background.

### Why the clipboard write happens in an offscreen document

Service workers cannot access the clipboard. Content scripts may not have focus during navigation. The offscreen document is an extension page that runs the engine and writes the clipboard. It is also the only place the extension can load WASM under its own Content Security Policy.

### Content Security Policy

`manifest.json` sets `script-src 'self' 'wasm-unsafe-eval'` for extension pages. This allows the bundled `.wasm` file to be instantiated. It does not allow remote code, `eval` from page content, or any script from a remote host.

## Text rules (Rust and JavaScript engines behave identically)

- Line endings become `\n`.
- Zero-width spaces (U+200B) and byte-order marks (U+FEFF) are removed. Zero-width joiners (U+200D) are kept so emoji sequences survive.
- Leading and trailing spaces on each line are removed, including ideographic spaces (U+3000) used for indentation.
- Runs of ordinary spaces inside a line become one space. Ideographic spaces inside a line are kept.
- Runs of blank lines become one blank line. Leading and trailing blank lines are removed.
- Wording, punctuation, dialogue, and repeated paragraphs are never changed or removed.
- Validation requires at least 100 non-whitespace characters. Shorter text is refused with a clear message instead of being copied.

## Installation

### Option A: JavaScript engine only (no build tools)

1. Unzip the project.
2. Open `chrome://extensions/` (Chrome) or `edge://extensions/` (Edge).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `webnovel-ultimate-copier` folder.
5. Reload any open WebNovel tabs.

### Option B: Rust/WASM engine

Prerequisites:

- Rust toolchain (install from https://rustup.rs). Run `rustup target add wasm32-unknown-unknown`.
- `wasm-pack`: `cargo install wasm-pack`.
- Node.js 18 or later (only for `npm run test:js`).

Build:

```bash
cd webnovel-ultimate-copier
npm run test:rust      # optional: run the Rust unit tests
npm run build:wasm     # creates wasm/text_engine.js and wasm/text_engine_bg.wasm
```

Check that both files exist in `wasm/`. Then load the folder unpacked as in Option A.

The first build creates `rust-engine/Cargo.lock`. Keep it so dependency versions stay pinned.

### Verifying which engine is active

Open the popup. The footer reads either **Text engine: Rust/WASM** or **Text engine: JavaScript fallback**, with the reason if WASM failed to load.

## Usage

| Action | How |
| --- | --- |
| Copy the chapter | Popup **Copy Entire Chapter**, or `Alt + Shift + C` |
| Select the chapter text | Popup **Select Chapter Text**, or `Alt + Shift + A` |
| Retry extraction | Popup **Retry Extraction**, or `Alt + Shift + R` |
| Auto-copy each next chapter | Turn on **Auto-Copy Next Chapter** in the popup |
| Ctrl + A selects only the chapter | Turn on **Use Ctrl + A for Chapter Selection** (off by default) |
| Include or leave out the title | Toggle **Include Chapter Title** |
| Preview | **Preview Chapter Text** |

Settings are saved in `chrome.storage.local` and persist across browser restarts.

### Customizing shortcuts

Open `chrome://extensions/shortcuts` (Chrome) or `edge://extensions/shortcuts` (Edge), find WebNovel Ultimate Chapter Copier, and set your own keys. Browser-reserved shortcuts cannot be changed by any extension.

### Custom sites

Settings → **Custom sites**: enter a site address, optionally a chapter URL pattern (a regular expression matched against the URL path), and click **Add site**. The browser asks permission for that site only.

## Ctrl + A behavior

- Off by default. Ctrl + A behaves normally.
- When on, Ctrl + A selects only the chapter body, and only on a supported chapter page with focus outside text fields.
- It never runs in inputs, textareas, or editable content, and never in the address bar.
- If chapter-only selection fails, the extension falls back to copying the chapter.

## Testing

### Automated

```bash
npm run test:js      # 20 tests on the JavaScript engine (runs without Rust)
npm run test:rust    # Rust unit tests in rust-engine/src/lib.rs (needs Rust)
```

The Rust tests and the JavaScript tests cover the same cases: empty and whitespace-only input, multiple paragraphs, CRLF, blank-line collapsing, Unicode and ideographic spacing, zero-width characters, emoji joiners, punctuation and dialogue, repeated paragraphs, character and paragraph counts, validation thresholds, and a 20,000-paragraph input.

### Manual checklist

1. Popup footer shows the expected engine.
2. Copy Entire Chapter copies the full chapter with a title.
3. Alt + Shift + C and Alt + Shift + R work on a chapter page.
4. Auto-Copy: turn it on, click Next Chapter, confirm the new chapter is copied and not the previous one.
5. Ctrl + A behaves normally with the setting off, and selects the chapter with it on.
6. With the WASM files removed, the popup reports the JavaScript fallback and copying still works.

## Troubleshooting

**Footer says "JavaScript fallback" and a reason.**
Run `npm run build:wasm`. If the build fails, see the next item. If the files exist but still fall back, the reason shown in the footer is the error. A common cause is a `wasm/` folder that was built for a different wasm-bindgen version. Rebuild with the pinned version in `rust-engine/Cargo.toml`.

**`npm run build:wasm` says wasm-pack is not installed.**
Run `cargo install wasm-pack`.

**Build fails with `wasm32-unknown-unknown` errors.**
Run `rustup target add wasm32-unknown-unknown`.

**Build fails on wasm-bindgen version mismatch.**
Remove `rust-engine/Cargo.lock` only if you have not pinned it on purpose. Otherwise run `cargo update -p wasm-bindgen --precise 0.2.92` inside `rust-engine/`.

**Rust tests fail to compile on Windows with linker errors.**
Install the Visual Studio C++ build tools. Rust native tests need the MSVC linker.

**"Chapter text is empty or too short to copy."**
Extraction found text, but fewer than 100 non-whitespace characters. Press Retry Extraction after the chapter finishes loading. If it keeps happening, the page layout may have changed.

**"Clipboard access was blocked. Click Copy Now."**
Click **Copy Now** on the page. The browser allows clipboard writes after a user click.

**"Extraction timed out."**
Increase the extraction timeout in Settings, or press Retry Extraction once the page has finished loading.

**Auto-Copy copies nothing after Next Chapter.**
Check the popup status line. Make sure Auto-Copy is on, and that the new chapter is a different chapter URL. Reload the page once after installing or updating the extension.

**Page layout changed and extraction fails.**
Update `CONFIG` in `content.js`: add the new class or ID to `contentSelectors`, then reload the extension and the WebNovel tab. A fallback finds the parent element with the most paragraph text, so this is only needed when that fallback also fails.

**Popup shows "Extension not active on this page."**
Reload the chapter tab. Content scripts do not attach to tabs that were open before the extension was installed or reloaded.

## Limitations

- The Rust engine has not been compiled in this package. It must be built and tested on your machine.
- Chapter-only selection covers the outermost content container, which may include stray labels on some pages.
- Only text the browser session can already see is copied. Locked or paywalled chapters are not bypassed.
- Duplicate-paragraph detection is intentionally not implemented, because legitimate chapters can repeat lines.
- Website selectors can break when the site changes its markup.

## Project structure

```
webnovel-ultimate-copier/
├── manifest.json            Manifest V3: permissions, CSP, commands, content script
├── popup.html / popup.css / popup.js
├── content.js               DOM extraction, navigation, Auto-Copy, Ctrl+A, Copy Now
├── background.js            Commands, message relay, custom site registration
├── offscreen.html / .js     Text engine host and clipboard writer
├── engine-loader.js         Loads WASM with self-test, falls back to JavaScript
├── js-fallback-engine.js    JavaScript mirror of the Rust engine
├── rust-engine/
│   ├── Cargo.toml
│   └── src/lib.rs           Rust text engine and unit tests
├── wasm/                    Generated by npm run build:wasm (not included)
├── tests/
│   └── js-fallback-engine.test.mjs
├── build-wasm.sh
├── package.json
├── icons/
└── README.md
```

## Disclaimer

WebNovel Ultimate Chapter Copier is an independent tool. It is not affiliated with, endorsed by, or sponsored by any website it works on. It copies text that a page already displays, to your clipboard, for your personal reading. Chapter text belongs to its authors and publishers. You are responsible for following each site's terms of service and applicable copyright law.

## Privacy

- Chapter text is processed in your browser only.
- The extension stores preferences in `chrome.storage.local`. It also keeps a few short-lived values in `sessionStorage` for the current tab, such as the last chapter ID and a signature of its text. Chapter text is not saved.
- Optional access is requested only for custom sites you add, one site at a time. Nothing is requested for other sites.
