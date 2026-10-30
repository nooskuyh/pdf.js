# Native MIME response handling

When `chrome.mimeHandler.getStreamInfo` is available, the extension consumes the
browser's original PDF response instead of fetching its URL again. Older browsers
retain interception and URL loading. Existing PDF redirect rules are replaced on
a handling-mode transition; wrong-MIME compatibility rules remain available.

The browser's stream is single-use. It is read completely before PDF.js processes
the bytes, and a failure does not automatically retry the original URL. POSTs and
single-use URLs are therefore supported without a GET replay. Original URLs,
fragments and response filenames remain available for titles and downloads.
Reading the whole response increases initial latency and memory use for large
documents. No PDF bytes are saved to persistent storage by this integration.

For full-tab documents, an extension-only port connects PDFHistory to the original
PDF wrapper's browser session history. The wrapper validates the sending extension
viewer and exact original URL. It never changes the URL when adding an entry.
Browser Back/Forward and mouse side buttons restore PDF positions; Back past the
first PDF position returns to the preceding webpage. The MIME extension frame
itself must not call pushState/replaceState, since that crashes tested Chromium
builds. Delayed destination-focus callbacks are cancelled during external-history
navigation so an older text render cannot override the restored position.

Embedded PDFs use isolated memory history without adding entries to their host
page. If the wrapper content script is unavailable (e.g. restricted site access
or local files without extension file access), the PDF still renders with memory
history, but browser buttons cannot restore its internal positions. A console
warning identifies that fallback. Grant the relevant access and reopen the PDF
to enable browser-history integration. The integration adds no permissions.

Chromium sometimes omits Content-Disposition from stream metadata. The background
observer caches only that header and its tab/frame/URL association for five
minutes, at most 64 records, to preserve response filenames. It stores no cookies,
authorization headers or PDF contents. Viewer metadata requests are validated
against the extension origin and tab.

## Validation

Use a Node.js version supported by package.json, then:

```sh
npm ci
npx gulp chromium generic lib-legacy
npx gulp lint
node --test test/chromium/mime_history_spec.mjs test/chromium/mime_document_spec.mjs
node node_modules/jasmine/bin/jasmine.js --helper=build/lib-legacy/test/unit/clitests_helper.js build/lib-legacy/test/unit/chrome_history_spec.js build/lib-legacy/test/unit/pdf_history_spec.js build/lib-legacy/test/unit/pdf_link_service_spec.js
PUPPETEER_EXECUTABLE_PATH=/path/to/chromium node test/chromium/test-mime-handler.mjs
```

The native browser test requires a Chromium build exposing the public MIME API.
It uses an isolated profile, a local server and a generated three-page fixture.
It checks response bytes, filename, original address/fragment, a one-use URL,
POST without GET replay, actual outline/page-number controls, browser history
commands and mouse back/forward events, forward-branch removal, exit to the
previous webpage, iframe/embed/object, local files and update deferral detection.
It separately disables ApiMimeHandler to check legacy interception and rendering;
that simulates API unavailability rather than testing every older browser release.
