import { createRoot, flush } from "solid-js";

// Effects queued while a root builds run on the next flush; a test that asserts straight after mounting settles them first.
export const createFlushedRoot: typeof createRoot = (init, options) => {
  const result = createRoot(init, options);
  flush();

  return result;
};

// An effect's write reaches the memos it feeds at the following flush, so a chain of effects needs one flush per link.
export const flushChain = (links = 4) => {
  for (let link = 0; link < links; link += 1) flush();
};
