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

// Some Chromium builds omit Content-Disposition from MIME stream information.
// Retain only that header from the original response, in bounded memory. Never
// refetch the URL or retain a response body/cookie/authorization header here.
"use strict";

(() => {
  const responses = new Map();
  const extensionBase = chrome.runtime.getURL("");
  const resource = url => url.split("#", 1)[0];
  chrome.webRequest.onHeadersReceived.addListener(
    details => {
      if (typeof chrome.mimeHandler?.getStreamInfo !== "function") {
        return;
      }
      const mime = details.responseHeaders?.find(
        header => header.name.toLowerCase() === "content-type"
      )?.value;
      if (
        mime?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf" ||
        details.statusCode < 200 ||
        details.statusCode >= 300
      ) {
        return;
      }
      const disposition = details.responseHeaders?.find(
        header => header.name.toLowerCase() === "content-disposition"
      )?.value;
      if (!disposition) {
        return;
      }
      for (const [key, entry] of responses) {
        if (details.timeStamp - entry.timestamp > 300000) {
          responses.delete(key);
        }
      }
      responses.set(
        `${details.tabId}:${details.frameId}:${resource(details.url)}`,
        {
          tabId: details.tabId,
          frameId: details.frameId,
          url: resource(details.url),
          timestamp: details.timeStamp,
          disposition,
        }
      );
      while (responses.size > 64) {
        responses.delete(responses.keys().next().value);
      }
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame"] },
    ["responseHeaders"]
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== "getMimeResponseMetadata") {
      return undefined;
    }
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(extensionBase) ||
      !sender.tab ||
      typeof message.url !== "string"
    ) {
      sendResponse(null);
      return undefined;
    }
    const matches = [...responses.values()].filter(
      entry =>
        entry.tabId === sender.tab.id &&
        entry.url === resource(message.url) &&
        Date.now() - entry.timestamp <= 300000
    );
    if (!matches.length) {
      sendResponse(null);
      return undefined;
    }
    if (new Set(matches.map(entry => entry.disposition)).size === 1) {
      sendResponse({ "Content-Disposition": matches[0].disposition });
      return undefined;
    }
    // Duplicate embedded URLs can have different response filenames. Match the
    // MIME frame's parent when available; do not guess among conflicting names.
    chrome.webNavigation
      .getFrame({ tabId: sender.tab.id, frameId: sender.frameId })
      .then(
        frame => {
          const match = matches.find(
            entry => entry.frameId === frame?.parentFrameId
          );
          sendResponse(
            match ? { "Content-Disposition": match.disposition } : null
          );
        },
        () => sendResponse(null)
      );
    return true;
  });
})();
