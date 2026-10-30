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
const hostSource = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "../../extensions/chromium/mime-history-host.js"
  ),
  "utf8"
);
const viewerSource = fs
  .readFileSync(
    path.join(import.meta.dirname, "../../web/chrome_history.js"),
    "utf8"
  )
  .replace(/export \{[^}]+\};?/, "");
class PopStateEvent extends Event {
  constructor(type, options) {
    super(type);
    this.state = options.state;
  }
}
const tick = () =>
  new Promise(resolve => {
    setImmediate(resolve);
  });
class ExtensionEvent {
  listeners = new Set();

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}
function setup({
  senderId = "own-extension",
  senderUrl,
  embedded = false,
  originalUrl,
  unavailable = false,
} = {}) {
  const url = "https://publisher.test/paper.pdf?ticket=one#page=1";
  const viewerUrl = "chrome-extension://own-extension/content/web/viewer.html";
  const onConnect = new ExtensionEvent();
  const calls = [],
    connections = [];
  const window = new EventTarget();
  window.top = window;
  const entries = [null];
  let index = 0;
  window.history = {
    get state() {
      return structuredClone(entries[index]);
    },
    replaceState(...args) {
      calls.push(["replace", args]);
      entries[index] = structuredClone(args[0]);
    },
    pushState(...args) {
      calls.push(["push", args]);
      entries.splice(index + 1);
      entries.push(structuredClone(args[0]));
      index++;
    },
    back() {
      if (index > 0) {
        index--;
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: this.state })
        );
      }
    },
    forward() {
      if (index + 1 < entries.length) {
        index++;
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: this.state })
        );
      }
    },
  };
  function connect(tabId, options) {
    if (unavailable) {
      throw new Error("no content script");
    }
    connections.push({ tabId, options });
    let closed = false;
    const a = {
      onMessage: new ExtensionEvent(),
      onDisconnect: new ExtensionEvent(),
    };
    const b = {
      onMessage: new ExtensionEvent(),
      onDisconnect: new ExtensionEvent(),
      name: options.name,
      sender: { id: senderId, url: senderUrl || viewerUrl, frameId: 2 },
    };
    a.postMessage = message =>
      queueMicrotask(() => {
        if (!closed) {
          b.onMessage.emit(structuredClone(message));
        }
      });
    b.postMessage = message =>
      queueMicrotask(() => {
        if (!closed) {
          a.onMessage.emit(structuredClone(message));
        }
      });
    a.disconnect = b.disconnect = () => {
      if (closed) {
        return;
      }
      closed = true;
      queueMicrotask(() => {
        a.onDisconnect.emit();
        b.onDisconnect.emit();
      });
    };
    onConnect.emit(b);
    return a;
  }
  const chrome = {
    runtime: { id: "own-extension", onConnect, getURL: () => viewerUrl },
    tabs: { connect },
  };
  vm.runInNewContext(hostSource, {
    window,
    document: { contentType: "text/html" },
    location: { href: url },
    chrome,
  });
  const connectBrowserHistory = vm.runInNewContext(
    viewerSource + "\nconnectBrowserHistory",
    {
      EventTarget,
      PopStateEvent,
      structuredClone,
      setTimeout,
      clearTimeout,
      chrome,
      console,
    }
  );
  return {
    window,
    calls,
    connections,
    connect: () =>
      connectBrowserHistory({
        tabId: 42,
        originalUrl: originalUrl || url,
        embedded,
      }),
  };
}

test("browser history bridge changes only wrapper state and forwards native traversal without changing URLs", async () => {
  const p = setup();
  const history = await p.connect();
  assert.ok(history);
  assert.equal(
    p.calls.length,
    0,
    "handshake does not create navigation entries"
  );
  history.replaceState({ uid: 0, destination: { page: 1 } });
  history.pushState({ uid: 1, destination: { page: 3 } });
  await tick();
  assert.equal(p.connections[0].tabId, 42);
  assert.equal(p.connections[0].options.frameId, 0);
  for (const [, args] of p.calls) {
    assert.equal(args.length, 2, "no URL argument is supplied");
  }
  const pops = [];
  history.addEventListener("popstate", event =>
    pops.push(event.state.destination.page)
  );
  // Direct host traversal represents the browser's Back/Forward commands.
  p.window.history.back();
  await tick();
  assert.equal(history.state.destination.page, 1);
  p.window.history.forward();
  await tick();
  assert.equal(history.state.destination.page, 3);
  assert.deepEqual(pops, [1, 3]);
  const copy = history.state;
  copy.destination.page = 9;
  assert.equal(history.state.destination.page, 3);
});

test("PDF named Back/Forward use the same wrapper history and new jumps truncate forward entries", async () => {
  const p = setup(),
    history = await p.connect();
  history.replaceState({ uid: 0, destination: { page: 1 } });
  history.pushState({ uid: 1, destination: { page: 2 } });
  await tick();
  history.back();
  await tick();
  assert.equal(history.state.destination.page, 1);
  history.pushState({ uid: 1, destination: { page: 3 } });
  await tick();
  history.forward();
  await tick();
  assert.equal(history.state.destination.page, 3);
});

test("host rejects foreign extensions, other extension pages, and mismatched original URLs", async () => {
  for (const options of [
    { senderId: "foreign-extension" },
    { senderUrl: "chrome-extension://own-extension/options/options.html" },
    { originalUrl: "https://other.test/paper.pdf" },
  ]) {
    const p = setup(options);
    assert.equal(await p.connect(), null);
    assert.equal(p.calls.length, 0);
  }
});

test("embedded PDFs do not connect and unavailable wrapper scripts allow the existing memory fallback", async () => {
  const embedded = setup({ embedded: true });
  assert.equal(await embedded.connect(), null);
  assert.equal(embedded.connections.length, 0);
  const unavailable = setup({ unavailable: true });
  assert.equal(await unavailable.connect(), null);
  assert.equal(unavailable.calls.length, 0);
});

test("MIME update deferral detects viewer frames independently of tab URLs", async () => {
  const source = fs.readFileSync(
    new URL("../../extensions/chromium/suppress-update.js", import.meta.url),
    "utf8"
  );
  for (const open of [true, false]) {
    let update;
    let reloads = 0;
    vm.runInNewContext(source, {
      chrome: {
        mimeHandler: { getStreamInfo() {} },
        runtime: {
          onUpdateAvailable: {
            addListener(listener) {
              update = listener;
            },
          },
          getContexts: async () =>
            open
              ? [
                  {
                    documentUrl:
                      "chrome-extension://id/content/web/viewer.html",
                  },
                ]
              : [],
          reload() {
            reloads++;
          },
        },
      },
    });
    update();
    await tick();
    assert.equal(reloads, open ? 0 : 1);
  }
});
