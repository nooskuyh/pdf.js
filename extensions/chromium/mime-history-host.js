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

// Browser history belongs to the original PDF wrapper, not the MIME handler
// extension frame. Use an extension-only port; do not expose this on
// postMessage.
"use strict";

(() => {
  // Chromium's original-URL PDF wrapper is a synthetic text/html document.
  // A MIME viewer with verified extension identity and this exact original URL
  // activates the bridge; ordinary webpages never change history on their own.
  if (window !== window.top) {
    return;
  }
  const viewerUrl = chrome.runtime.getURL("content/web/viewer.html");
  const stateKey = "pdfjsHistory";
  let activePort = null;

  function readState() {
    const value = window.history.state?.[stateKey];
    return value?.version === 1 ? value.state : null;
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "pdf-browser-history") {
      return;
    }
    const sender = port.sender;
    if (
      sender?.id !== chrome.runtime.id ||
      sender.url?.split(/[?#]/, 1)[0] !== viewerUrl
    ) {
      port.disconnect();
      return;
    }
    let ready = false;
    const onPopState = () => {
      if (ready) {
        port.postMessage({ type: "popstate", state: readState() });
      }
    };
    const disconnect = () => {
      window.removeEventListener("popstate", onPopState);
      if (activePort === port) {
        activePort = null;
      }
      ready = false;
    };
    port.onDisconnect.addListener(disconnect);
    port.onMessage.addListener(message => {
      if (!ready) {
        if (
          message?.type !== "connect" ||
          message.originalUrl !== location.href
        ) {
          port.disconnect();
          return;
        }
        activePort?.disconnect();
        activePort = port;
        ready = true;
        // PDFHistory restores page/zoom/scroll itself. Browser
        // scroll restoration
        // must not later overwrite the descendant viewer's restored position.
        window.history.scrollRestoration = "manual";
        window.addEventListener("popstate", onPopState);
        port.postMessage({ type: "ready", state: readState() });
        return;
      }
      try {
        switch (message?.type) {
          case "push":
          case "replace": {
            const state = {
              ...window.history.state,
              [stateKey]: { version: 1, state: message.state },
            };
            // Omit the URL entirely. The original address, including any
            // existing fragment, is unchanged and the PDF is never reloaded.
            window.history[
              message.type === "push" ? "pushState" : "replaceState"
            ](state, "");
            port.postMessage({ type: "committed", sequence: message.sequence });
            break;
          }
          case "back":
            window.history.back();
            break;
          case "forward":
            window.history.forward();
            break;
        }
      } catch {
        port.postMessage({ type: "error", sequence: message?.sequence });
      }
    });
  });
})();
