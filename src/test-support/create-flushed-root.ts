import { children, createRenderEffect, createRoot, flush, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

// Effects queued while a root builds run on the next flush; a test that asserts straight after mounting settles them first.
export const createFlushedRoot: typeof createRoot = (init, options) => {
  const result = createRoot(init, options);
  flush();

  return result;
};

// A component's returned element is lazy in Solid 2: its children (a context provider's subtree) run only while something observes it,
// so the render effect keeps the subtree alive until the surrounding root is disposed.
export const mountElement = (build: () => JSX.Element) => {
  const element = children(() => untrack(build));
  createRenderEffect(element, () => {});
};

// An effect's write reaches the memos it feeds at the following flush, so a chain of effects needs one flush per link.
export const flushChain = (links = 4) => {
  for (let link = 0; link < links; link += 1) flush();
};
