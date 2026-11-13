# Google AI Mode Scraper

A browser-console experiment for extracting Google AI Mode replies as Markdown while the response is being generated.

The extractor observes the response DOM, identifies the newly-created AI Mode reply, and serializes its content into Markdown. It also records mutation-level diagnostics so you can inspect whether text is appearing incrementally in the page rather than only being collected after generation finishes.

> **Current stable version: v10** — the v10 automated integration runner passed all 5 checks in a live Google AI Mode session.

## Features

- Detects a newly generated AI Mode reply by its heading.
- Observes the reply as it streams into the page.
- Reconstructs Markdown while preserving common structures:
  - Headings and paragraphs
  - Ordered and unordered lists, including nested lists
  - Bold, italic, inline code, links as link text, superscript and subscript
  - Tables as Markdown pipe tables
  - Code blocks as fenced Markdown, including a detected language label when available
- Filters citation controls, source UI and the standard AI response completion footer.
- Tracks DOM mutations, text-node appends and replacements, block updates, and duplicate mutation records.
- Exposes a controller for checking status or stopping an extraction.
- Includes an automated integration runner for the main behaviours.

## Repository layout

```text
js/
  v10.js
  tests/
    v10-test-auto.js
```

## Requirements

- Google AI Mode open in a desktop browser.
- A page state where the **Ask anything** text area is available.
- Browser DevTools with a Console.
- An internet connection to load the automated test runner's copy of `js/v10.js` from GitHub.

The extractor is designed around the current Google AI Mode page structure. Google can change that structure at any time, which may require updates to the selectors or boundary detection.

## Run the extractor

1. Open Google AI Mode.
2. Open the browser's Developer Tools and select the **Console**.
3. Open [`js/v10.js`](js/v10.js) in this repository and copy its contents.
4. Paste the script into the Console and run it.
5. The script submits the prompt configured near the top of the file and waits for the reply.

By default, the script uses:

```js
var prompt = "Explain quantum entanglement.";
```

Change that value before running the script to submit a different prompt.

### Output

The Console displays timestamped events such as:

- `[DETECTED]` — the new reply heading was found.
- `[BOUNDARY]` — the DOM element selected as the reply container.
- `[BLOCK]` — a content block was discovered.
- `[MARKDOWN CHUNK]` — additional Markdown appeared in an existing block.
- `[EDIT]` — an existing block changed rather than simply growing.
- `[ANSWER TEXT APPEND]` — a text node grew during a mutation batch.
- `[ANSWER TEXT REPLACEMENT]` — the page replaced or revised text in a node.
- `[COMPLETE]` — extraction finished.
- `[FINAL MARKDOWN]` — the reconstructed Markdown output.

The final result is also stored in:

```js
window.lastExtractedMarkdown
```

You can inspect or copy it from the Console:

```js
copy(window.lastExtractedMarkdown)
```

### Controller

The active extractor exposes `window.__aiModeExtractor`.

Check its current state and diagnostics:

```js
window.__aiModeExtractor.status()
```

Stop the current run:

```js
window.__aiModeExtractor.stop()
```

Starting the script again stops the previous extractor before creating a new run.

## Automated integration tests

The test runner sends several prompts to Google AI Mode and checks the resulting extraction. It fetches the current `js/v10.js` directly from this repository, so it tests the committed version rather than a separately pasted copy.

1. Open Google AI Mode and make sure the **Ask anything** text area is available.
2. Open DevTools Console.
3. Copy and run the contents of [`js/tests/v10-test-auto.js`](js/tests/v10-test-auto.js).
4. Start the test suite:

```js
await window.__v10AutoTest.run()
```

The runner performs five checks across multiple prompts:

| Test | What it checks |
| --- | --- |
| Citation/source exclusion | Citation markers, source URLs and source-interface text are excluded from the extracted Markdown. |
| Consecutive questions / newest response | A second run detects and extracts the new response rather than reusing the previous one. |
| Markdown structure preservation | Headings, numbered and nested lists, tables, fenced code blocks, and bold formatting are retained. |
| Stop during live streaming | The extractor can be stopped after live text mutations have been observed. |
| Restart and fresh extraction | A new extraction can start after stopping the previous one. |

The runner prints a result table and returns the individual test results. The full details are available at:

```js
window.__v10AutoTest.report()
window.__v10AutoTest.state.results
```

To request cancellation:

```js
window.__v10AutoTest.cancel()
```

**Note:** The integration tests interact with the live Google AI Mode page and submit prompts. They are not isolated unit tests, so results can vary with network conditions, response generation, and changes to Google's interface.

## How streaming detection works

The script starts a document-level observer before submitting the prompt. It looks for a newly added heading matching the configured prompt, then attaches a second observer to the detected reply container.

The reply is divided into content units and serialized individually. The extractor keeps previous versions of each unit so it can distinguish newly discovered blocks, appended Markdown and edits to existing content.

For character-level diagnostics, the observer requests each text mutation's previous value. Multiple mutation records for the same text node in one observer batch are coalesced and compared with the node's final value. This avoids reporting misleading intermediate changes when the DOM changes several times before the observer callback runs.

The completion logic uses the page's standard completion text when available, with a quiet-period fallback and a maximum timeout.

## Versions

- **v10** — current stable version. Adds Markdown table and fenced code-block serialization, with structural collection support for both.
- **v9** — adds diagnostics for duplicate character-mutation records and batch coalescing.
- **v8** — adds answer-unit filtering and mutation-batch coalescing.
- **v7** — adds character-level mutation diagnostics.
- **v6 Remastered** — adds timestamped diagnostics, mutation statistics, streaming counters and a status controller.
- **v3–v5.6** — earlier iterations of response detection, boundary selection and Markdown extraction.

The v10 implementation is the recommended starting point for further development.

## Limitations

- This is a DOM-based scraper, not an official Google API.
- It depends on Google's current page structure, labels, and completion behaviour.
- It is intended for use in the browser Console on an open AI Mode page; it is not a standalone Node.js package or browser extension.
- Markdown serialization is best-effort. Unusual layouts or future changes to Google's rendered HTML may not map perfectly to Markdown.
- The script submits prompts through the page UI and relies on the page being ready to accept them.

## Disclaimer

This project is an independent experiment and is not affiliated with or endorsed by Google. Use it in accordance with Google's terms and applicable policies.
