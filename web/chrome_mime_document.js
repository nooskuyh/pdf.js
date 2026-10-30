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

// An actual MIME handler document has no explicit ?file=/DNR URL. Keep its
// browser-created document and stream association intact; never navigate it to
// a pretty extension URL or refetch originalUrl.
const query = document.location.search.slice(1);
const explicitFile =
  /(?:^|&)file=[^&]+/.test(query) || query.startsWith("DNR:");
const isMimeDocument =
  !explicitFile && typeof chrome.mimeHandler?.getStreamInfo === "function";

const infoResult = isMimeDocument
  ? Promise.resolve()
      .then(() => chrome.mimeHandler.getStreamInfo())
      .then(
        info => ({ info }),
        () => ({ info: null })
      )
  : Promise.resolve({ info: null });
let consumed = false;

async function getMimeDocumentInfo() {
  return (await infoResult).info;
}

function filename(headers) {
  const value = Object.entries(headers || {}).find(
    ([name]) => name.toLowerCase() === "content-disposition"
  )?.[1];
  const disposition = Array.isArray(value)
    ? value.join("; ")
    : String(value || "");
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(
    disposition
  );
  let name = plain
    ? (plain[1] ?? plain[2]).trim().replaceAll(/\\(.)/g, "$1")
    : "";
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1].trim());
    } catch {}
  }
  return Array.from(name, char => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 || char === "/" || char === "\\"
      ? "_"
      : char;
  }).join("");
}

async function loadMimeDocument(app) {
  if (consumed) {
    return;
  }
  consumed = true;
  try {
    const info = await getMimeDocumentInfo();
    if (!info?.streamUrl || !info.originalUrl) {
      throw new Error(
        "The browser did not provide a PDF stream. Open the original PDF address to try again."
      );
    }
    let originalFilename = filename(info.responseHeaders);
    if (!originalFilename) {
      try {
        const headers = await chrome.runtime.sendMessage({
          action: "getMimeResponseMetadata",
          url: info.originalUrl,
        });
        originalFilename = filename(headers);
      } catch {}
    }
    const response = await fetch(info.streamUrl);
    if (!response.ok) {
      throw new Error(
        "The browser's PDF stream could not be read. Open the original PDF address to try again."
      );
    }
    // The stream is single-use. Finish reading it before handing the bytes to
    // PDF.js so that it never needs to request originalUrl (including POSTs).
    const data = new Uint8Array(await response.arrayBuffer());
    await app.open({
      data,
      url: info.originalUrl,
      originalUrl: info.originalUrl,
      filename: originalFilename,
      length: data.length,
    });
  } catch {
    // Never retry originalUrl: POSTs and single-use requests are not
    // repeatable.
    await app._documentError("pdfjs-loading-error", {
      message: "Unable to open the browser-provided PDF stream.",
    });
  }
}

export { getMimeDocumentInfo, isMimeDocument, loadMimeDocument };
