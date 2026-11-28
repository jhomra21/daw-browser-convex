import { installGlobals } from "./install-globals";

// Bun has no global window, and @tanstack/solid-query reads `typeof window` once at load to choose server mode,
// which skips the query-cache subscription that delivers setQueryData updates to hooks. Load it as a browser would
// (the app and Solid 1 under the browser condition did), then put the globals back.
const restore = installGlobals({ window: {} });

try {
  await import("@tanstack/solid-query");
} finally {
  restore();
}
