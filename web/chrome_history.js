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

/* globals chrome */

// Mirror the original PDF wrapper's session history for PDFHistory's
// synchronous
// state API. All browser navigation stays in that wrapper, outside the MIME
// frame.
class BrowserHistory extends EventTarget {
  #port;

  #state;

  #onDisconnect;

  #sequence = 0;

  #committed = 0;

  constructor(port, state) {
    super();
    this.#port = port;
    this.#state = state;
    port.onMessage.addListener(message => {
      if (message?.type === "popstate") {
        this.#state = message.state;
        this.dispatchEvent(
          new PopStateEvent("popstate", { state: this.state })
        );
      } else if (message?.type === "committed") {
        this.#committed = Math.max(this.#committed, message.sequence);
      } else if (message?.type === "error") {
        this.#committed = Math.max(
          this.#committed,
          message.sequence || this.#sequence
        );
        console.warn("PDF browser history update failed.");
      }
    });
    this.#onDisconnect = () => {
      // Reading lastError also prevents an unhandled extension API error.
      void chrome.runtime.lastError;
      this.#port = null;
    };
    port.onDisconnect.addListener(this.#onDisconnect);
  }

  get state() {
    return structuredClone(this.#state);
  }

  get pending() {
    return !!this.#port && this.#sequence > this.#committed;
  }

  pushState(state) {
    this.#state = structuredClone(state);
    this.#port?.postMessage({
      type: "push",
      state: this.#state,
      sequence: ++this.#sequence,
    });
  }

  replaceState(state) {
    this.#state = structuredClone(state);
    this.#port?.postMessage({
      type: "replace",
      state: this.#state,
      sequence: ++this.#sequence,
    });
  }

  back() {
    this.#port?.postMessage({ type: "back" });
  }

  forward() {
    this.#port?.postMessage({ type: "forward" });
  }
}

async function connectBrowserHistory(info) {
  if (!info || info.embedded || !Number.isInteger(info.tabId)) {
    return null;
  }
  return new Promise(resolve => {
    let port;
    let settled = false;
    const finish = value => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      port?.onMessage.removeListener(onMessage);
      port?.onDisconnect.removeListener(onDisconnect);
      if (!value) {
        port?.disconnect();
      }
      resolve(value);
    };
    const onMessage = message => {
      if (message?.type === "ready") {
        finish(new BrowserHistory(port, message.state));
      }
    };
    const onDisconnect = () => {
      void chrome.runtime.lastError;
      finish(null);
    };
    const timer = setTimeout(() => finish(null), 2000);
    try {
      port = chrome.tabs.connect(info.tabId, {
        frameId: 0,
        name: "pdf-browser-history",
      });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      port.postMessage({ type: "connect", originalUrl: info.originalUrl });
    } catch {
      finish(null);
    }
  });
}

// Session history for a browser-owned MIME frame. Never navigate that frame or
// touch the browser's History API: its PDF response stream is single-use.
class MemoryHistory extends EventTarget {
  #entries = [];

  #index = -1;

  #generation = 0;

  get state() {
    return this.#index < 0 ? null : structuredClone(this.#entries[this.#index]);
  }

  pushState(state) {
    const entry = structuredClone(state);
    this.#entries.splice(this.#index + 1);
    this.#entries.push(entry);
    this.#index++;
  }

  replaceState(state) {
    const entry = structuredClone(state);
    if (this.#index < 0) {
      this.#entries.push(entry);
      this.#index = 0;
    } else {
      this.#entries[this.#index] = entry;
    }
  }

  back() {
    this.#traverse(-1);
  }

  forward() {
    this.#traverse(1);
  }

  reset() {
    this.#generation++;
    this.#entries.length = 0;
    this.#index = -1;
  }

  #traverse(delta) {
    const generation = this.#generation;
    // Like browser history, traversal completes asynchronously. Discard queued
    // traversals when PDFHistory resets for a closed or replacement document.
    queueMicrotask(() => {
      if (generation !== this.#generation) {
        return;
      }
      const index = this.#index + delta;
      if (index < 0 || index >= this.#entries.length) {
        return;
      }
      this.#index = index;
      this.dispatchEvent(new PopStateEvent("popstate", { state: this.state }));
    });
  }
}

export { connectBrowserHistory, MemoryHistory };
