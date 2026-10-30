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

import { MemoryHistory } from "../../web/chrome_history.js";

describe("Chrome MIME memory history", function () {
  const originalPopStateEvent = globalThis.PopStateEvent;
  beforeAll(function () {
    if (!originalPopStateEvent) {
      globalThis.PopStateEvent = class extends Event {
        constructor(type, { state }) {
          super(type);
          this.state = state;
        }
      };
    }
  });
  afterAll(function () {
    if (!originalPopStateEvent) {
      delete globalThis.PopStateEvent;
    }
  });

  it("snapshots positions and truncates the forward branch", async function () {
    const history = new MemoryHistory();
    history.replaceState({ page: 1 });
    history.pushState({ page: 2 });
    history.back();
    await Promise.resolve();
    expect(history.state).toEqual({ page: 1 });
    history.pushState({ page: 3 });
    history.forward();
    await Promise.resolve();
    expect(history.state).toEqual({ page: 3 });
    const state = history.state;
    state.page = 4;
    expect(history.state.page).toEqual(3);
  });

  it("discards queued traversal when the document resets", async function () {
    const history = new MemoryHistory();
    history.replaceState({ page: 1 });
    history.pushState({ page: 2 });
    const pop = jasmine.createSpy("pop");
    history.addEventListener("popstate", pop);
    history.back();
    history.reset();
    history.replaceState({ page: 5 });
    await Promise.resolve();
    expect(pop).not.toHaveBeenCalled();
    expect(history.state).toEqual({ page: 5 });
  });
});
