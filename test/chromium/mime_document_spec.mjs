/* Copyright 2024 Mozilla Foundation
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
const source = fs
  .readFileSync(
    path.join(import.meta.dirname, "../../web/chrome_mime_document.js"),
    "utf8"
  )
  .replace(/export \{[^}]+\};?/, "");

function setup({
  search = "",
  api = true,
  infoFails = false,
  fetchFails = false,
} = {}) {
  const requests = [],
    opens = [],
    alerts = [];
  const bytes = Uint8Array.from([37, 80, 68, 70, 45, 49]);
  const original = "https://publisher.test/paper.pdf?token=ORIGINAL_SECRET";
  let read = false,
    infoCalls = 0;
  const context = vm.createContext({
    Uint8Array,
    Promise,
    URL,
    navigator: { language: "en-US" },
    document: {
      location: { search },
      createElement: () => ({ setAttribute() {} }),
      body: { append: node => alerts.push(node.textContent) },
    },
    chrome: {
      mimeHandler: api
        ? {
            getStreamInfo: () => {
              infoCalls++;
              if (infoFails) {
                throw new Error("NO_STREAM_SECRET");
              }
              return Promise.resolve({
                streamUrl: "stream://browser-buffer",
                originalUrl: original,
                responseHeaders: {
                  "Content-Disposition":
                    "inline; filename*=UTF-8''paper%20notes.pdf",
                },
              });
            },
          }
        : undefined,
    },
    fetch: async url => {
      requests.push(url);
      if (fetchFails) {
        throw new Error("FETCH_SECRET");
      }
      return {
        ok: true,
        arrayBuffer: async () => {
          read = true;
          return bytes.buffer;
        },
      };
    },
  });
  const module = vm.runInContext(
    source + "\n({isMimeDocument,getMimeDocumentInfo,loadMimeDocument})",
    context
  );
  const app = {
    _documentError: async (key, { message }) => alerts.push(message),
    open: async args => {
      assert.equal(read, true, "read the stream completely before processing");
      opens.push(args);
    },
  };
  return {
    module,
    app,
    requests,
    opens,
    alerts,
    original,
    bytes,
    infoCalls: () => infoCalls,
  };
}

test("MIME response is read exactly once, preserving URL, filename and bytes", async () => {
  const probe = setup();
  assert.equal(probe.module.isMimeDocument, true);
  await probe.module.loadMimeDocument(probe.app);
  await probe.module.loadMimeDocument(probe.app);
  assert.deepEqual(probe.requests, ["stream://browser-buffer"]);
  assert.equal(probe.infoCalls(), 1);
  assert.equal(probe.opens.length, 1);
  assert.equal(probe.opens[0].url, probe.original);
  assert.equal(probe.opens[0].filename, "paper notes.pdf");
  assert.deepEqual(probe.opens[0].data, probe.bytes);
  assert.equal(probe.alerts.length, 0);
});

test("explicit viewer URLs and unavailable APIs keep legacy loading", async () => {
  for (const options of [
    { search: "?file=https%3A%2F%2Fpublisher.test%2Fpaper.pdf" },
    { search: "?DNR:https://publisher.test/paper.pdf?token=abc" },
    { api: false },
  ]) {
    const probe = setup(options);
    assert.equal(probe.module.isMimeDocument, false);
    assert.equal(await probe.module.getMimeDocumentInfo(), null);
    assert.equal(probe.infoCalls(), 0);
    assert.equal(probe.requests.length, 0);
  }
});

test("missing association and failed stream reads never refetch the original URL", async () => {
  for (const options of [{ infoFails: true }, { fetchFails: true }]) {
    const probe = setup(options);
    await probe.module.loadMimeDocument(probe.app);
    await probe.module.loadMimeDocument(probe.app);
    assert.ok(probe.requests.every(url => url === "stream://browser-buffer"));
    assert.equal(probe.requests.length, options.infoFails ? 0 : 1);
    assert.equal(probe.opens.length, 0);
    assert.equal(probe.alerts.length, 1);
    assert.ok(!probe.alerts[0].includes("SECRET"));
  }
});

test("rendering failure reports an error without another stream or original URL fetch", async () => {
  const probe = setup();
  await probe.module.loadMimeDocument({
    ...probe.app,
    open: async () => {
      throw new Error("render error");
    },
  });
  assert.deepEqual(probe.requests, ["stream://browser-buffer"]);
  assert.equal(probe.alerts.length, 1);
});
