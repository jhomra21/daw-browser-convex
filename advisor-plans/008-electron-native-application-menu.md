# Electron native application menu parity

## Goal

Remove the duplicate renderer `File`, `Edit`, `View`, `Settings`, and `Tracks` menus from the Electron build, move their complete behavior and dynamic state into Electron's native application menu, preserve the existing renderer menus in browser/PWA builds, and leave the browser/sidebar toggle in the renderer toolbar.

## Verified constraints

- `TransportControls` owns the duplicate renderer menubar and an independent sidebar toggle.
- `Timeline` already owns the authoritative callbacks and reactive state used by the renderer menus.
- `useTimelineKeyboard` owns overlapping accelerators, so Electron-native accelerators must not also execute through the renderer listener.
- `main.ts` has one active `BrowserWindow` and no application-menu implementation.
- `preload.ts` exposes one context-isolated, typed bridge.
- Electron's current documented pattern is `Menu.buildFromTemplate()` plus `Menu.setApplicationMenu()`, standard `role` items for native application/window behavior, custom `click` handlers for app commands, and mutable `MenuItem` state for `enabled`, `visible`, and `checked`.

## Implementation

### 1. Add a closed, shared menu contract

Add a small shared module that can be imported by Electron main, preload, renderer, and tests without importing Electron or DOM APIs.

- Define a closed `DesktopApplicationMenuCommand` discriminated union covering every current renderer menu action:
  - project/dashboard/import/export/auth/account actions;
  - undo, redo, duplicate, delete, and keyboard shortcuts;
  - three browser destinations;
  - metronome, loop, grid, zoom, and each grid denominator;
  - settings/dashboard/timeline/audio/about destinations;
  - Sync Mix and all four track creation actions.
- Define `DesktopApplicationMenuState` with only state that the native menu actually consumes:
  - renderer/timeline readiness;
  - local-project archive export eligibility;
  - signed-in state;
  - metronome, loop, grid, Sync Mix checks;
  - selected grid denominator.
- Add runtime parsers/type guards for both incoming commands and state. Reject unknown keys, invalid enum values, and malformed IPC payloads.
- Keep the contract minimal. Do not serialize callbacks, tracks, projects, router objects, or transport models.

### 2. Build the native menu in a focused Electron module

Create `apps/desktop/application-menu.ts`.

- Build the menu once with `Menu.buildFromTemplate()` and install it with `Menu.setApplicationMenu()`.
- Follow native organization:
  - On macOS, begin with the application menu using roles for About, Services, Hide, Hide Others, Show All, and Quit. Put app Settings in this menu where native convention requires it.
  - Keep DAW project and import/export actions under File.
  - Keep DAW semantic Undo, Redo, Duplicate, and Delete under Edit. Do not replace DAW operations with Electron roles.
  - Put browser destinations, metronome/loop/grid, zoom, grid resolution, and fullscreen under View. Use Electron's fullscreen role.
  - Keep track commands under Tracks.
  - Add the standard Window menu with native roles.
  - Keep Help/About routing consistent with platform convention without duplicating About on macOS.
- Use stable IDs for all dynamic items.
- Use checkbox items for metronome, loop, grid, and Sync Mix.
- Use one radio group for grid denominators `2 | 4 | 8 | 12 | 16`.
- Route custom item clicks through one typed command sender targeting only the current live main window.
- Mutate retained menu items for state changes rather than rebuilding the menu.
- Initial custom commands are disabled until the renderer publishes ready state.
- Authentication state controls Sign In versus Account/Logout visibility.
- Local project state controls `.dawproject` archive export enablement.

### 3. Add constrained, validated IPC

Extend `apps/desktop/preload.ts`, `src/types/desktop-bridge.ts`, and main-process IPC registration.

- Main to renderer:
  - fixed channel for typed menu commands;
  - preload validates payloads before invoking renderer listeners;
  - `onCommand` returns deterministic cleanup that removes the exact listener.
- Renderer to main:
  - fixed channel for complete menu state snapshots;
  - preload validates state before sending;
  - main validates again and only accepts messages from the current trusted main window.
- Expose only:

  ```ts
  applicationMenu: {
    onCommand(listener): () => void
    setState(state): void
  }
  ```

- Do not expose raw `ipcRenderer`, channel names, `Menu`, or `MenuItem`.

### 4. Reuse Timeline's existing command implementations

Add a focused renderer controller/helper with a consumer-shaped API around `Timeline`.

- Subscribe once to `window.dawDesktop?.applicationMenu.onCommand`.
- Dispatch every command to the exact callback/router/auth action already used by `transportProps`, the five renderer menus, or `useTimelineKeyboard`.
- Move Sign In, Account, Logout, and route-only actions out of hidden menu component-local behavior so web and Electron share the same implementation.
- Publish a complete reactive state snapshot with a Solid effect.
- Clean up the command subscription with `onCleanup`.
- Keep `transportProps()` as the UI command/state source. Do not create a second business-logic implementation in Electron main.

### 5. Remove only the Electron renderer menubar

Update `TransportControls`.

- Always retain the browser/sidebar toggle.
- Render `<Menubar>` and the five existing menu components only when the desktop application-menu bridge is absent.
- Preserve all central transport and right-side controls unchanged.
- Preserve browser/PWA behavior and menu markup unchanged.

### 6. Give each accelerator one owner

- Assign Electron menu accelerators for menu-backed DAW commands where they are safe and equivalent:
  - Undo, Redo, Duplicate, Export Mixdown, track creation, group/ungroup, browser toggle as applicable.
- Disable only those overlapping branches in `useTimelineKeyboard` when the native application-menu bridge exists.
- Keep `Space` in the renderer because it depends on timeline/editable-target context.
- Keep Delete/Backspace in the renderer unless the native path can preserve editable-target and local-timeline safeguards exactly.
- Keep timeline-semantic Copy/Paste in the renderer unless explicitly added as custom native menu commands. Do not substitute Electron's DOM copy/paste roles for DAW clip operations.
- Preserve browser/PWA shortcut behavior unchanged.

### 7. Tests

Add focused tests for:

- complete command parity against all existing renderer menu actions;
- platform-specific template structure, application roles, Window roles, labels, separators, accelerators, checkbox/radio types;
- state mutation for readiness, archive export, auth visibility, toggles, Sync Mix, and exactly one grid denominator;
- command dispatch to a live trusted renderer and no dispatch to a destroyed/missing window;
- preload command validation, state validation, and exact unsubscribe behavior;
- renderer command adapter calling the existing handlers;
- desktop state publication;
- desktop-only menubar hiding while retaining the sidebar toggle;
- web renderer menus remaining present;
- shortcut ownership preventing double execution while preserving Space, guarded Delete, Copy, and Paste behavior.

Prefer pure module tests and existing source-contract testing patterns. Do not add a browser automation framework solely for this change.

## Validation

Run and fix until clean:

1. Focused menu, preload, Timeline, TransportControls, and keyboard tests.
2. `bun run typecheck`
3. `bun test`
4. `bun run build`
5. Desktop package checks and packaged build using the repository's existing scripts.
6. Inspect the packaged Electron app:
   - only the sidebar toggle remains in renderer top-left chrome;
   - native menus contain complete parity;
   - checked/radio/auth/archive states update live;
   - each accelerator executes once;
   - standard macOS application and Window roles behave natively.

## Risks to avoid

- Do not duplicate DAW business logic in Electron main.
- Do not trust renderer IPC payloads without validation.
- Do not rebuild the entire application menu for each reactive state change.
- Do not let native accelerators and capture-phase renderer shortcuts both fire.
- Do not use native DOM edit roles as replacements for timeline-semantic operations.
- Do not remove browser/PWA renderer menus.
- Do not alter audio/session lifecycle or the accepted native-tail baseline.

## Opus review corrections (authoritative)

The execution must apply these corrections where they differ from the earlier sections:

- Put the shared strict Zod command/state schemas in
  `packages/desktop-protocol/src/application-menu.ts` and export them through an
  isolated package subpath. Do not change the versioned socket protocol.
- Cover exactly the 39 actions currently present in the five renderer menus.
  Do not add keyboard-only Copy/Paste, Group/Ungroup, Space, or sidebar-toggle
  actions to this menu migration.
- Extend the Timeline project-menu model so Sign In, Logout, and About use
  shared renderer callbacks. Preserve the current `/Login` route casing,
  `/about` route, `authClient.signOut()`, and session-query clearing behavior.
- Keep every existing DAW shortcut renderer-owned in this change. Do not add
  custom Electron accelerators for Undo, Redo, Duplicate, Delete, Export,
  track creation, Group/Ungroup, browser toggle, Copy/Paste, or Space. Their
  existing focus and editable-target guards must remain unchanged.
- Use `import.meta.env.VITE_DESKTOP === "true"` to hide the renderer menubar,
  matching the project's established product-build gating. Do not use bridge
  presence as the UI condition.
- Electron's native About role is not equivalent to the app's `/about` route.
  Use a custom About command. On macOS put About and Settings in the
  application menu; on Windows/Linux retain top-level Settings and put About
  in Help.
- Keep the menu pure/testable without requiring Electron runtime in Bun tests.
  Separate or inject the Electron installation boundary.
- Renderer state is authoritative. After checkbox/radio clicks, immediately
  reapply the last accepted snapshot because Electron optimistically mutates
  `checked`.
- Add a menu-controller reset and invoke it on renderer navigation, renderer
  crash, and Timeline cleanup so stale commands never remain enabled.
- Main IPC must require the current main window's `webContents`, the main
  frame rather than an iframe, and the existing trusted same-app origin.
- Use source-contract tests where direct Electron/preload runtime tests are
  unavailable. Do not add a new browser, DOM, or Electron test framework.
- Do not change the existing close/quit lifecycle or add multi-window/macOS
  reopen behavior as part of this focused task.
