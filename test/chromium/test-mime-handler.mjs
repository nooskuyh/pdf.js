/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals chrome, PDFViewerApplication */

// Run after `npx gulp chromium`. Requires a browser with chrome.mimeHandler.
// PUPPETEER_EXECUTABLE_PATH can select a locally installed Chromium browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const extensionPath = path.resolve(import.meta.dirname, "../../build/chromium");
const fixturePath = path.join(import.meta.dirname, "mime-handler.pdf");
const bytes = fs.readFileSync(fixturePath);
const requests = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/start") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<a href="/once.pdf?ticket=one#page=1">PDF</a><form method="POST" action="/post.pdf"><button>POST</button></form>'
    );
    return;
  }
  if (pathname === "/embeds") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<iframe src="/iframe.pdf"></iframe><embed src="/embed.pdf" type="application/pdf"><object data="/object.pdf" type="application/pdf"></object>'
    );
    return;
  }
  if (!pathname.endsWith(".pdf")) {
    res.writeHead(204);
    res.end();
    return;
  }
  requests.push({ url: req.url, method: req.method });
  if (
    (pathname === "/once.pdf" &&
      requests.filter(r => r.url === req.url).length > 1) ||
    (pathname === "/post.pdf" && req.method !== "POST")
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": bytes.length,
    "Content-Disposition": "inline; filename*=UTF-8''browser%20stream.pdf",
  });
  res.end(bytes);
});
await new Promise(resolve => {
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  const target = await browser.waitForTarget(
    t => t.type() === "service_worker"
  );
  const worker = await target.worker();
  assert.equal(
    await worker.evaluate(() => typeof chrome.mimeHandler?.getStreamInfo),
    "function"
  );
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await page.createCDPSession();
  async function viewerFor(hostPage) {
    let viewer;
    await hostPage.waitForFunction(() => document.readyState !== "loading");
    for (let i = 0; i < 100; i++) {
      viewer = hostPage
        .frames()
        .find(frame => frame.url().includes("/content/web/viewer.html"));
      if (viewer) {
        break;
      }
      await new Promise(resolve => {
        setTimeout(resolve, 50);
      });
    }
    assert.ok(viewer, "the public MIME API must create the extension viewer");
    await viewer.waitForFunction(
      () => window.PDFViewerApplication?.isInitialViewSet,
      { polling: 100, timeout: 15000 }
    );
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication.pdfDocument.numPages),
      3
    );
    return viewer;
  }
  let viewer;
  async function waitPage(number) {
    await viewer.waitForFunction(
      expected => {
        const app = PDFViewerApplication;
        return (
          app.page === expected &&
          app.pdfHistory._position?.page === expected &&
          !app.pdfHistory.popStateInProgress &&
          !app.pdfHistory._history.pending
        );
      },
      { polling: 100, timeout: 15000 },
      number
    );
  }
  async function jump(number) {
    await viewer.$eval("#pageNumber", element => element.select());
    await page.keyboard.type(String(number));
    await page.keyboard.press("Enter");
    await waitPage(number);
  }
  await page.goto(origin + "/start");
  await page.click("a");
  viewer = await viewerFor(page);
  assert.ok(
    await worker.evaluate(
      async () =>
        (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).length > 0
    ),
    "update deferral must see a native MIME viewer with its original tab URL"
  );
  const original = page.url();
  assert.equal(
    await viewer.evaluate(() => PDFViewerApplication._docFilename),
    "browser stream.pdf"
  );
  assert.deepEqual(
    Buffer.from(
      await viewer.evaluate(async () =>
        Array.from(await PDFViewerApplication.pdfDocument.getData())
      )
    ),
    bytes
  );
  await viewer.click("#viewsManagerToggleButton");
  await viewer.click("#viewsManagerSelectorButton");
  await viewer.click("#outlinesViewMenu");
  await viewer.waitForSelector("#outlinesView a");
  const outlineLinks = await viewer.$$("#outlinesView a");
  await outlineLinks[1].click();
  await waitPage(2);
  await page.goBack();
  await waitPage(1);
  await page.goForward();
  await waitPage(2);
  for (const button of ["back", "forward"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 800,
      y: 400,
      button,
      buttons: button === "back" ? 8 : 16,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 800,
      y: 400,
      button,
      buttons: 0,
      clickCount: 1,
    });
    await waitPage(button === "back" ? 1 : 2);
  }
  assert.equal(page.url(), original);
  assert.equal(requests.filter(r => r.url.startsWith("/once.pdf")).length, 1);
  await page.goBack();
  await waitPage(1);
  await jump(3);
  const history = await cdp.send("Page.getNavigationHistory");
  assert.equal(history.currentIndex, history.entries.length - 1);
  for (let i = 0; i < 10 && page.url() === original; i++) {
    await page.goBack();
  }
  assert.equal(page.url(), origin + "/start");
  assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
  console.log(
    "PASS: one-use response, filename, bytes, original URL, browser/mouse history, new branch and exit to previous webpage"
  );

  await page.click("button");
  viewer = await viewerFor(page);
  await jump(1);
  await jump(3);
  await page.goBack();
  await waitPage(1);
  assert.deepEqual(
    requests.filter(r => r.url === "/post.pdf").map(r => r.method),
    ["POST"]
  );
  console.log("PASS: POST PDF without GET replay, including browser Back");

  const embeds = await browser.newPage();
  await embeds.goto(origin + "/embeds");
  for (let i = 0; i < 100; i++) {
    if (
      embeds.frames().filter(f => f.url().includes("/content/web/viewer.html"))
        .length === 3
    ) {
      break;
    }
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
  }
  const frames = embeds
    .frames()
    .filter(f => f.url().includes("/content/web/viewer.html"));
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    await frame.waitForFunction(
      () => window.PDFViewerApplication?.pdfDocument?.numPages === 3,
      { polling: 100 }
    );
    assert.equal(
      await frame.evaluate(() => PDFViewerApplication.isViewerEmbedded),
      true
    );
  }
  const local = await browser.newPage();
  await local.goto(pathToFileURL(fixturePath).href);
  await viewerFor(local);
  assert.deepEqual(errors, []);
  console.log("PASS: iframe/embed/object and native local-file streams");

  await browser.close();
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-features=ApiMimeHandler",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  const legacyTarget = await browser.waitForTarget(
    t => t.type() === "service_worker"
  );
  const legacyWorker = await legacyTarget.worker();
  assert.equal(
    await legacyWorker.evaluate(() => typeof chrome.mimeHandler?.getStreamInfo),
    "undefined"
  );
  const legacy = await browser.newPage();
  await legacy.goto(origin + "/legacy.pdf");
  await legacy.waitForFunction(
    () => window.PDFViewerApplication?.isInitialViewSet,
    { polling: 100, timeout: 15000 }
  );
  assert.equal(
    await legacy.evaluate(() => PDFViewerApplication.pdfDocument.numPages),
    3
  );
  assert.equal(
    await legacy.evaluate(
      () => PDFViewerApplication.pdfHistory.usesExternalHistory
    ),
    false
  );
  console.log(
    "PASS: API-unavailable browser keeps legacy PDF interception, rendering and browser history"
  );
} finally {
  await browser?.close();
  await new Promise(resolve => {
    server.close(resolve);
  });
}
