# Area 5: Desktop shell

The shell has strong safety boundaries: renderer requests are generation-scoped, host loss is surfaced to playback, and close waits for recording settlement and renderer preparation before destroying the window. The clearest experience gaps are delayed first window creation, sparse menu shortcuts, and menu state that is too coarse to reflect whether an action can run.

## Findings

### DS-01 — Startup gates first window on independent setup work

- **Category:** B
- **Evidence:** `apps/desktop/main.ts:2295-2299,2331-2339,2348-2354,2621-2625`
  > `app.whenReady().then(async () => {`
  > `await pluginCatalogStore.initialize(...)`
  > `const recordingStartup = await initializeRecordingSpoolRegistry(...)`
  > `await startSocket()`
  > `createWindow()`
- **User experience:** No desktop window appears until native helper self-test, package/catalog setup, spool initialization, IPC wiring, and socket startup have all completed. Trusted VST revalidation and storage initialization therefore delay even the first renderer paint.
- **Minimal fix:** Separate launch-critical setup from optional catalog and non-audio storage work. Create the window after required IPC/protocol setup, then publish feature availability as optional setup completes; keep native VST trust gates intact.
- **Size:** M
- **Risk:** Medium
- **Verify:** In a packaged app, record launch-to-window and launch-to-first-paint with empty and populated plugin catalogs; confirm the window becomes usable before catalog revalidation finishes and native plugin operations remain unavailable until ready.

### DS-02 — Core menu commands lack keyboard accelerators

- **Category:** A
- **Evidence:** `apps/desktop/application-menu.ts:153-163,237-255`
  > `commandItem(menuIds.undo, "Undo", "undo", sendCommand),`
  > `commandItem(menuIds.redo, "Redo", "redo", sendCommand),`
  > `accelerator: "Command+,"`
- **User experience:** The native menu declares no keyboard accelerators for Undo, Redo, Duplicate, or Delete; Settings is the only menu item with an explicit accelerator. Users get no shortcut hints in the menu, and native menu accelerator dispatch is not configured for these common actions.
- **Minimal fix:** Add platform-appropriate accelerators to the existing command items, starting with undo/redo and duplicate; avoid shortcuts that conflict with existing timeline bindings.
- **Size:** S
- **Risk:** Low
- **Verify:** In packaged macOS and Windows builds, invoke each accelerator with and without timeline focus and verify the intended action fires once without triggering a conflicting renderer shortcut.

### DS-03 — Menu enablement cannot reflect selection/history availability

- **Category:** A
- **Evidence:** `packages/desktop-protocol/src/application-menu.ts:71-80`; `apps/desktop/application-menu.ts:271-311`; `src/hooks/useDesktopApplicationMenu.ts:177-191`
  > `ready: z.boolean(),`
  > `for (const id of statefulIds) { ... item.enabled = state.ready }`
  > `ready: true,`
- **User experience:** Once the renderer is ready, Undo, Redo, Duplicate, and Delete all become enabled regardless of history or selection. Choosing a command that currently has no applicable target can appear broken or do nothing.
- **Minimal fix:** Extend menu state with narrowly scoped availability flags for history and selection actions, derive them from existing timeline state, and apply them only to those menu items.
- **Size:** M
- **Risk:** Low
- **Verify:** In a packaged app, check menu state on an empty project, after an edit, after undoing all edits, and with/without a selection; disabled commands should match the corresponding renderer action availability.

### DS-04 — Ellipsis labels use two different glyph conventions

- **Category:** A
- **Evidence:** `apps/desktop/application-menu.ts:140-143,242-243`
  > `"Import Audio Files..."`
  > `"Export Mixdown..."`
  > `"Settings…"`
- **User experience:** File actions use three periods while Settings uses a single ellipsis glyph. The menu copy looks inconsistent, especially across adjacent platform-specific menus.
- **Minimal fix:** Normalize all menu labels to one ellipsis convention in `createApplicationMenuTemplate`.
- **Size:** S
- **Risk:** Low
- **Verify:** Inspect the packaged File and application menus on macOS and Windows and confirm all action labels use the same glyph convention.

### DS-05 — Main process module combines many independent shell responsibilities

- **Category:** C
- **Evidence:** `apps/desktop/main.ts:990-1004,1126-1159,2130-2244,2295-2636`
  > `const registerIpc = () => {`
  > `const createWindow = () => {`
  > `const prepareQuit = async () => {`
  > `app.whenReady().then(async () => {`
- **User experience / maintenance cost:** The same 2,638-line module owns renderer lifecycle, IPC validation, file capabilities, native host supervision, window/close behavior, startup, and power recovery. Shell changes require readers to trace a large amount of unrelated state and increase the risk of regressions across those boundaries.
- **Minimal fix:** Extract one responsibility at a time, beginning with startup orchestration and native host lifecycle wiring, keeping `main.ts` as a thin composition root and preserving current protocol contracts.
- **Size:** L
- **Risk:** Medium
- **Verify:** Run the existing focused desktop checks after each extraction and use packaged-observable checks for launch, audio-host loss/recovery, and close/quit; confirm no behavior or IPC contract changes.

### DS-06 — Private IPC channel names are repeated across main and preload

- **Category:** C
- **Evidence:** `apps/desktop/main.ts:344,379-380`; `apps/desktop/preload.ts:73-77`
  > `const offlinePcmAckChannel = "daw:audio-host:offline-pcm-ack"`
  > `const applicationMenuCommandChannel = "daw:application-menu:command"`
  > `const offlinePcmAckChannel = "daw:audio-host:offline-pcm-ack"`
- **User experience / maintenance cost:** Shared channel identifiers must be kept synchronized manually between Electron main and preload. Renaming or adding a channel can silently disconnect a bridge event.
- **Minimal fix:** Put shared shell IPC channel identifiers in a small `@daw-browser/desktop-protocol` module and import them in both processes; leave process-private channels local.
- **Size:** S
- **Risk:** Low
- **Verify:** Confirm main/preload compile against the shared identifiers and exercise menu commands, offline-render acknowledgements, and host-loss notification in a packaged app.

## Looked at and fine

- **Close and quit safety:** `apps/desktop/close-flow.ts:10-28` prevents concurrent close attempts, waits for recording twice around renderer preparation, requires explicit discard confirmation, and reports failures without destroying the window. Recording finalization has a separate settle path in `apps/desktop/audio-host.ts:2685-2689`.
- **Audio host loss and recovery:** `apps/desktop/main.ts:477-496,2360-2375,2517-2519` updates lifecycle state and publishes host-loss notifications; `src/hooks/useTimelinePlayback.ts:623-680` surfaces recovery state and supports retry. No missing user-visible loss path was found.
- **IPC error handling:** `apps/desktop/preload.ts:167-174` converts close-preparation rejection to a host error; main-process request/reply paths apply deadlines and return bounded failures (`apps/desktop/main.ts:623-647,942-975`). Best-effort cancellation catches in preload are limited to cleanup requests.
- **Menu labels:** The `...` versus `…` inconsistency is recorded in DS-04; no other divergent spelling for the same menu action was found.
- **Benchmark and diagnostics gating:** Heartbeat, startup trace, quiet capture, and recording telemetry are opt-in (`apps/desktop/benchmark-runtime.ts:24,57,67,124-126`; `apps/desktop/main.ts:127-129,336-337`). No ungated benchmark polling or production diagnostic loop was found.
- **IPC throughput and payloads:** Recording uses batches and offline PCM uses bounded chunk/ack flow. Meter, spectrum, and schedule notifications are forwarded as event batches/frames (`apps/desktop/main.ts:2557-2567`); no unbatched per-sample IPC or unbounded payload claim is supported by the inspected code.
- **Synchronous main-process work:** The inspected synchronous filesystem checks are existence checks, and cryptographic hashing is used for bounded plugin state validation. No concrete launch-path blocking issue beyond the awaited startup sequence in DS-01 was established.
- **Window size:** The window is deliberately maximized before showing, with a minimum-size frame retained as its restore size (`apps/desktop/main.ts:2134-2153`); no separate saved-bounds restore implementation was found.
- **Scoped renderer-side helpers:** `attached-host-controller.ts`, `capability-file.ts`, `native-diagnostics-serialization.ts`, and `native-playback-abort.ts` have active consumers and no unused export was identified.
