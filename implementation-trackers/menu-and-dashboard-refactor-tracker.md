# Menu And Dashboard Refactor Tracker

> Created: 2026-06-18
> Branch: `menu-and-dashboard-refactor`
> Base branch: `master`
> Scope: reorganize the timeline top menus, dedupe dashboard action surfaces, and add a compact Ableton-style left browser for Assets, Effects, and MIDI Instruments.
>
> 1. Keep top-level menus focused: **File**, **Edit**, **Project**, **Media**, **Settings**, **Tracks**.
> 2. Make the dashboard a detailed management/settings surface, not a duplicate quick-action surface.
> 3. Add a hideable, resizable left browser above the bottom effects/sample panel.
> 4. Move device insertion out of the effects panel toolbar and into the browser.

## Purpose

This tracker captures the implementation plan for the menu, dashboard, and left-browser refactor.

The goal is to make the DAW chrome scale like an Ableton-style workspace: primary actions live in predictable menus, detailed project/app management lives in the dashboard, and assets/devices live in a persistent browser surface beside the timeline.

This tracker should be updated during the branch with implementation notes, rejected candidates, review findings, bugs, decisions, and validation artifacts.

---

## Branch

- Current branch: `menu-and-dashboard-refactor`
- Base branch: `master`

---

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Ableton Browser reference: official Ableton Live manual Browser layout and library behavior
- Reference codebase: `/Users/juan/Documents/monorepo-new`
  - `apps/web/src/components/sidebar-left/project-menu/*`
  - `apps/web/src/components/sidebar-left/assets.tsx`
  - `apps/web/src/components/sidebar-left/asset-item.tsx`
  - `apps/web/src/context/layout.tsx`
- Reference codebase: `/Users/juan/Documents/dialkit`
  - `src/solid/components/Panel.tsx`
  - `src/solid/components/Folder.tsx`
  - `src/solid/components/SegmentedControl.tsx`
  - `src/solid/components/SelectControl.tsx`

## Current DAW Files To Inspect Before Implementation

- `src/components/Timeline.tsx`
- `src/components/timeline/TransportControls.tsx`
- `src/components/timeline/projects-menu.tsx`
- `src/components/timeline/project-media-menu.tsx`
- `src/components/timeline/transport-types.ts`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/timeline-panels.tsx`
- `src/components/timeline/EffectsPanel.tsx`
- `src/components/timeline/TimelineBottomPanelShell.tsx`
- `src/hooks/useTimelineBottomPanelState.ts`
- `src/hooks/useTimelineSidebarResize.ts`
- `src/hooks/useProjectSamples.ts`
- `src/hooks/useSamplesMenuController.ts`
- `src/hooks/useExportsMenuController.ts`
- `src/components/dashboard/dashboard.tsx`
- `src/components/dashboard/types.ts`
- `src/hooks/useDashboardRouteParam.ts`
- `src/lib/timeline-layout.ts`

---

## Current State

### Top Menus

The top menu rendering currently lives mostly in `src/components/timeline/TransportControls.tsx`.

Current rendered order:

```tsx
<FileMenu toolbar={props} />
<EditMenu toolbar={props} />
<ProjectsMenu projectMenu={props.projectMenu} menu={projectsMenu} />
<ProjectMediaMenu samples={samplesMenu} exportsMenu={exportsMenu} />
<SettingsMenu toolbar={props} />
<TracksMenu tracksMenu={props.tracksMenu} />
<ShareMenu ... />
```

Current issues:

- `TransportControls.tsx` owns too many menu implementations.
- `ProjectMediaMenu` mixes dashboard links, project sample lists, default sample lists, insert actions, export actions, copy actions, and delete actions.
- `ShareMenu` is a separate top-level category, but the target taxonomy does not include `Share`.
- Dashboard actions and top-menu actions overlap.

### Dashboard

Current dashboard views:

```ts
export type DashboardView =
  | "general"
  | "account"
  | "projects"
  | "files"
  | "samples"
  | "timeline"
  | "keyboard"
  | "export";
```

The dashboard should remain the detailed management surface. Top menus and the new browser should own quick actions.

### Timeline Layout

Current timeline workspace has a scroll area and sticky right sidebar:

```tsx
<div class="flex-1 flex min-h-0" ref={props.containerRef}>
  <div class="flex-1 relative overflow-auto timeline-scroll" ref={props.scrollRef}>
    ...
    <div class="sticky right-0 z-40 flex h-full shrink-0">
      <TrackSidebar ... />
    </div>
  </div>
</div>
```

The bottom panel is fixed:

```tsx
<div class="fixed left-0 right-0 bottom-0 z-50 ...">
```

The left browser must live in the main workspace, stop above the bottom panel, and not overlap the fixed bottom panel.

### Effects Panel

Device insertion currently lives inside `EffectsPanel`:

```tsx
<EffectsPanelToolbar
  toolbar={{
    showAddMidiClip: isInstrumentTrack(),
    showAddArp: isInstrumentTrack() && !instrumentState.arp.params(),
    onAddMidiClip: instrumentState.addMidiClip,
    showAddEq: !eqForTarget(),
    showAddReverb: !reverbForTarget(),
    onAddArp: instrumentState.arp.add,
    onAddEq: eqState.add,
    onAddReverb: reverbState.add,
    canWrite: canWriteCurrentTargetEffects(),
  }}
/>
```

Future device insertion should live in the left browser. The effects panel should keep rendering device cards and empty/read-only states.

---

## Target Menu Taxonomy

### File

- New project
- Open projects dashboard
- Import audio files
- Import `.dawproject`
- Export `.dawproject`
- Export mixdown
- Account or sign in
- Logout

### Edit

- Undo
- Redo
- Keyboard shortcuts

### Project

- Save status
- Back up now
- Choose storage folder
- Share or copy invite link
- Restore cloud backup
- Duplicate cloud backup
- Download for offline
- Disable backup
- Retry shared changes
- Rename current project
- Delete project

### Media

- Show or hide Browser
- Browser tab: Assets
- Browser tab: Effects
- Browser tab: MIDI Instruments
- Open samples dashboard
- Open export dashboard only if still useful after dedupe

### Settings

- General settings
- Timeline / DAW settings
- Toggle metronome
- Toggle loop
- Toggle grid
- Grid resolution
- About

### Tracks

- Add audio track
- Add instrument track
- Add return track
- Add group track
- Sync mix

### Share Menu Decision

Remove `Share` as a top-level menu. Move share/copy invite behavior under **Project** because sharing is part of the project lifecycle.

---

## Target Layout

### Current Layout

```txt
┌──────────────────────────────────────────────┐
│ Menus / Transport                            │
├──────────────────────────────────────────────┤
│ Timeline lanes                       Sidebar │
│ Timeline lanes                       Sidebar │
│ Timeline lanes                       Sidebar │
├──────────────────────────────────────────────┤
│ Fixed bottom effects/sample panel            │
└──────────────────────────────────────────────┘
```

### Future Layout

```txt
┌──────────────────────────────────────────────┐
│ Menus / Transport                            │
├───────┬──────────────────────────────┬───────┤
│Browser│ Timeline lanes               │Sidebar│
│Assets │ Timeline lanes               │Sidebar│
│Effects│ Timeline lanes               │Sidebar│
│MIDI   │ Timeline lanes               │Sidebar│
├───────┴──────────────────────────────┴───────┤
│ Fixed bottom effects/sample panel             │
└──────────────────────────────────────────────┘
```

Hidden state:

```txt
┌──────────────────────────────────────────────┐
│ Menus / Transport                            │
├──────────────────────────────────────┬───────┤
│ Timeline lanes                       │Sidebar│
│ Timeline lanes                       │Sidebar│
├──────────────────────────────────────┴───────┤
│ Fixed bottom effects/sample panel             │
└──────────────────────────────────────────────┘
```

---

## Target File Layout

```txt
src/components/timeline/menus/
  daw-menubar.tsx
  file-menu.tsx
  edit-menu.tsx
  project-menu.tsx
  media-menu.tsx
  settings-menu.tsx
  tracks-menu.tsx
  menu-action-types.ts

src/components/timeline/browser/
  timeline-left-browser.tsx
  browser-tabs.tsx
  browser-assets-tab.tsx
  browser-effects-tab.tsx
  browser-midi-instruments-tab.tsx
  browser-item-row.tsx
  browser-types.ts

src/hooks/
  useTimelineLeftBrowserState.ts
  useTimelineLeftBrowserResize.ts
  useTimelineBrowserCatalog.ts

src/lib/
  timeline-left-browser-preferences.ts
```

Implementation note:

- `project-media-menu.tsx` should not survive as a parallel media menu. Rename, split, or delete it during the menu extraction.
- `projects-menu.tsx` should be renamed or replaced by the new `menus/project-menu.tsx`, not left as a competing project menu.

---

## Left Browser State

### Browser Tabs

```ts
export type TimelineBrowserTab = "assets" | "effects" | "midi-instruments";
```

### State Shape

```ts
export type TimelineLeftBrowserState = {
  open: Accessor<boolean>;
  widthPx: Accessor<number>;
  activeTab: Accessor<TimelineBrowserTab>;
  searchQueryByTab: Accessor<Record<TimelineBrowserTab, string>>;
  scrollTopByTab: Accessor<Record<TimelineBrowserTab, number>>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: TimelineBrowserTab) => void;
  setSearchQuery: (tab: TimelineBrowserTab, query: string) => void;
  setScrollTop: (tab: TimelineBrowserTab, scrollTop: number) => void;
  previewWidthPx: (widthPx: number) => void;
  commitWidthPx: (widthPx: number) => void;
};
```

### Defaults

```ts
export const TIMELINE_LEFT_BROWSER_MIN_WIDTH = 220;
export const TIMELINE_LEFT_BROWSER_DEFAULT_WIDTH = 280;
export const TIMELINE_LEFT_BROWSER_MAX_WIDTH_RATIO = 0.42;
export const TIMELINE_LEFT_BROWSER_MIN_TIMELINE_WIDTH = 360;
```

The max-width calculation must account for the right sidebar so the timeline lanes cannot be crushed to near-zero width.

Max-width should use both constraints:

```ts
const layoutMaxWidth =
  containerWidth - rightSidebarWidthPx() - TIMELINE_LEFT_BROWSER_MIN_TIMELINE_WIDTH;
const ratioMaxWidth = containerWidth * TIMELINE_LEFT_BROWSER_MAX_WIDTH_RATIO;
const maxWidth = Math.max(
  TIMELINE_LEFT_BROWSER_MIN_WIDTH,
  Math.min(layoutMaxWidth, ratioMaxWidth),
);
```

---

## Browser Toggle Behavior

Do not unmount the browser on hide if that would reset search, expanded folder state, or scroll position.

Prefer:

```tsx
<TimelineLeftBrowser
  browser={props.leftBrowser}
  style={{ display: props.leftBrowser.open ? undefined : "none" }}
/>
```

If implementation needs unmounting for simplicity, persist at minimum:

- active tab
- search query per tab
- scroll position per tab
- width
- open/closed state

Add a keyboard shortcut in the browser shell phase. Ableton uses `Cmd+Alt+B`; use the platform-appropriate equivalent while avoiding conflicts with existing shortcuts.

Shortcut acceptance criteria:

- Check the existing shortcut handling before adding a new listener or registry entry.
- Use `Mod+Alt+B` unless it conflicts with existing app/browser behavior.
- Ignore the shortcut while focus is inside inputs, textareas, selects, or contenteditable elements.
- Keep the shortcut scoped to timeline/browser chrome, not global dashboard state.

Persistence acceptance criteria:

- Persist at minimum open/closed state, width, active tab, search query per tab, and scroll position per tab.
- Prefer the existing app/timeline preference storage path if one exists; otherwise add a small dedicated local-storage helper.
- Clamp persisted width on load and whenever the container/sidebar size changes.
- Do not trust DOM persistence alone for scroll position. Store scroll position explicitly per tab.

---

## Browser Resize Model

Mirror the existing right sidebar resize pattern from `useTimelineSidebarResize`, but reverse the delta for a left-side panel.

```ts
export function useTimelineLeftBrowserResize(options: {
  widthPx: Accessor<number>;
  setWidthPx: (value: number) => void;
  getContainerElement: () => HTMLDivElement | undefined;
  rightSidebarWidthPx: Accessor<number>;
}): { onPointerDown: (event: PointerEvent) => void } {
  // pointer down on browser right edge
  // delta = event.clientX - resizeStartX
  // nextWidth = clamp(startWidth + delta)
}
```

The resize handle belongs on the browser's right edge:

```tsx
<button
  type="button"
  aria-label="Resize browser"
  class="absolute right-0 top-0 h-full w-2 cursor-ew-resize"
  onPointerDown={props.browser.onResizePointerDown}
/>
```

Do not add animation or transition classes.

---

## Browser Catalog Model

Separate item source from item category. This avoids mixing sample source distinctions with device type distinctions.

```ts
export type BrowserItemSource = "project" | "default" | "builtin";

export type BrowserItemCategory =
  | "sample"
  | "audio-effect"
  | "midi-effect"
  | "midi-instrument";

export type BrowserItem = {
  id: string;
  source: BrowserItemSource;
  category: BrowserItemCategory;
  label: string;
  subtitle?: string;
  searchText: string;
  disabled?: boolean;
};
```

Tab-specific models:

```ts
export type BrowserAssetsModel = {
  items: Accessor<BrowserItem[]>;
  itemById: Accessor<Map<string, BrowserItem>>;
  query: Accessor<string>;
  setQuery: (query: string) => void;
  onInsert: (itemId: string) => void;
  onDragStart: (event: DragEvent, itemId: string) => void;
};

export type BrowserDevicesModel = {
  effects: Accessor<BrowserItem[]>;
  instruments: Accessor<BrowserItem[]>;
  itemById: Accessor<Map<string, BrowserItem>>;
  onAddEffect: (itemId: string) => void;
  onAddInstrument: (itemId: string) => void;
};
```

Performance rules:

- Precompute lowercase `searchText`.
- Use `Map<string, BrowserItem>` for event-handler lookup.
- Avoid repeated `.find()` calls in hot paths.
- Keep lists flat.
- Add simple windowing when row counts exceed a practical threshold.
- Do not load heavy asset metadata unless the Assets tab is active.

---

## Asset Loading At Scale

`useProjectSamples` currently returns arrays for project and default samples. Before wiring the browser to it, verify whether the underlying cloud/local sample reads are paginated or bounded enough for large projects.

If not bounded, the Assets tab needs one of these before it is considered complete:

1. cursor-based loading for project samples
2. search-backed query paging
3. a capped initial load with explicit "load more"

The browser can render thousands of rows with windowing, but rendering optimization does not fix an unbounded initial data fetch.

This check must happen before the Assets tab is wired. If sample reads are unbounded, Phase 3 includes the cap/paging/load-more fix rather than treating it as a follow-up.

---

## Drag And Drop Strategy

The browser lives in a different DOM subtree from timeline lanes, so drag behavior must be explicit.

Preferred initial strategy:

- Reuse the existing HTML5 sample drag payload shape from `useSamplesMenuController`.
- Start drag from `TimelineLeftBrowser`.
- Let the existing root/timeline `onDragOver` and `onDrop` paths consume the payload.
- Verify that dragging from the browser into the scroll container preserves drop lane and start-time calculation.

If HTML5 drag events cannot preserve the current behavior, use a shared drag context owned by `Timeline` rather than browser-local pointer hit-testing.

Do not implement a new drag/drop system unless the existing sample drag path cannot be reused.

---

## Effects Panel Integration

The browser needs access to actions that currently live inside `EffectsPanel`.

Preferred direction:

```ts
export type TimelineDeviceInsertActions = {
  addMidiClip: () => Promise<void>;
  addArpeggiator: () => void;
  addEq: () => void;
  addReverb: () => void;
  canAddForCurrentTarget: Accessor<boolean>;
};
```

Longer-term shape:

```txt
Timeline
  useTimelineDeviceController(...)
    returns:
      effectsPanelModel
      browserDeviceActions

EffectsPanel
  renders model only

TimelineLeftBrowser
  invokes browserDeviceActions
```

Short-term acceptable shape:

- Extract only the device insertion actions needed by the browser.
- Keep the rest of `EffectsPanel` stable.
- Do not create a generic effects framework.

After browser insertion works, remove `EffectsPanelToolbar` and update empty-state copy:

```txt
No devices on this target. Add instruments or effects from the Browser.
```

All browser device actions must preserve existing write-permission checks.

Device insertion acceptance criteria:

- Browser items must be disabled or no-op under the same permission conditions as the current effects toolbar.
- Existing target-specific availability rules must be preserved, including EQ/Reverb/Arpeggiator duplicate prevention.
- Do not introduce a generic device framework in this branch.
- Keep extraction narrow: expose only the insertion actions and availability state needed by the browser.

---

## TimelineWorkspace API

Current:

```tsx
<TimelineWorkspace
  bottomPanelOffsetPx={bottomPanel.bottomPanelOffsetPx()}
  sidebarWidth={sidebarWidth()}
  ...
/>
```

Future:

```tsx
<TimelineWorkspace
  bottomPanelOffsetPx={bottomPanel.bottomPanelOffsetPx()}
  sidebarWidth={sidebarWidth()}
  leftBrowser={{
    open: leftBrowser.open(),
    widthPx: leftBrowser.widthPx(),
    activeTab: leftBrowser.activeTab(),
    onToggle: leftBrowser.toggleOpen,
    onSelectTab: leftBrowser.setActiveTab,
    onResizePointerDown: leftBrowserResize.onPointerDown,
    assets: browserCatalog.assets,
    devices: browserCatalog.devices,
  }}
  ...
/>
```

Before implementing browser height, verify the actual parent offset model in `timeline-workspace.tsx`. Do not blindly apply `height: calc(100% - bottomPanelOffsetPx)` if the parent already accounts for the bottom panel.

---

## Dashboard Dedupe Rules

Dashboard remains route-param backed with `?dashboard=...`, but it should stop competing with top menus and the browser for quick actions.

### Keep In Dashboard

- General
- Account
- Projects
- Local Files
- Samples
- Timeline / DAW
- Keyboard Shortcuts
- Export

### Dedupe Direction

- **Projects view** keeps detailed project list and management. Menus own quick project lifecycle actions.
- **Samples view** keeps detailed sample management, metadata, file paths, delete/copy, diagnostics, and missing-media details. Browser owns quick browse/insert/drag.
- **Export view** keeps export details, history, defaults, and diagnostics if backed by real state. Menus own "Export mixdown".
- **Timeline / DAW view** keeps detailed preferences. Settings menu owns quick toggles.
- **Keyboard view** keeps shortcut reference/remap surface. Edit or Settings menu owns quick entry.

Do not remove dashboard views just because a quick action moves to a menu. Remove only duplicate buttons or shortcut rows that now have a better canonical home.

Before Phase 6, add a short checklist of the exact duplicate controls to remove from each dashboard view. Keep management, diagnostics, history, metadata, and settings controls unless they are clearly duplicated by a new canonical menu/browser action.

---

## Implementation Phases

### Phase 1: Menu Extraction

Split this into two commits/steps so extraction and behavior changes stay reviewable.

#### Phase 1A: Behavior-Preserving Extraction

- Move menu components out of `TransportControls.tsx`.
- Keep rendered menu categories, labels, actions, and ordering unchanged.
- Convert `projects-menu.tsx` into the new project menu location or remove it after extraction.
- Convert `project-media-menu.tsx` into the new media menu location or remove it after extraction.

#### Phase 1B: Menu Taxonomy Update

- Apply the target top-level taxonomy: **File**, **Edit**, **Project**, **Media**, **Settings**, **Tracks**.
- Move share/copy invite actions into the Project menu.
- Remove `Share` as a top-level menu.
- Keep dashboard links only where they are entry points to detailed management surfaces.

Validation:

- `bun run typecheck`
- `bun run build`

### Phase 2: Left Browser Shell And Real Menu/Browser Actions

This phase intentionally combines the action model with the browser shell so abstractions are shaped by two real consumers.

- Add persisted left browser state.
- Add left browser resize hook.
- Mount browser in `TimelineWorkspace`.
- Add Media menu show/hide/tab commands.
- Add keyboard shortcut for quick show/hide.
- Keep the browser mounted or persist state needed across hides.
- Verify bottom panel offset behavior before final height math.

Validation:

- `bun run typecheck`
- `bun run build`

### Phase 3: Assets Tab

- Use existing project/default sample data paths.
- Verify whether sample reads are bounded or need paging before wiring the tab.
- If sample reads are unbounded, add cursor loading, search-backed paging, or a capped initial load with explicit "load more" in this phase.
- Render project/default sample rows.
- Support insert and drag using existing sample controller behavior.
- Keep detailed delete/copy management in dashboard unless safely moved.

Validation:

- `bun run typecheck`
- `bun run build`

### Phase 4: Effects And MIDI Instruments Tabs

- Add browser catalog items for EQ, Reverb, Arpeggiator, and Synth.
- Extract the minimum device insertion actions needed by the browser.
- Wire browser item clicks to existing add behavior.
- Preserve write-permission checks.

Validation:

- `bun run typecheck`
- `bun run build`

### Phase 5: Remove EffectsPanel Toolbar

- Delete `EffectsPanelToolbar` and related toolbar-only helpers.
- Update empty-state copy.
- Verify browser insertion covers MIDI clip, Arp, EQ, Reverb, and instrument behavior expected by the old toolbar.

Validation:

- `bun run typecheck`
- `bun run build`

### Phase 6: Dashboard Cleanup

- Write the per-view duplicate-control checklist before deleting controls.
- Remove duplicate quick-action buttons that now live in menus/browser.
- Keep dashboard views as detailed management/settings surfaces.
- Keep sidebar view count unchanged unless a view becomes genuinely empty.
- Verify URL param behavior still works for all views.

Validation:

- `bun run typecheck`
- `bun run build`

---

## Suggested Commit Boundaries

Keep commits independently buildable and easy to review:

1. **Menu extraction only**
   - Phase 1A behavior-preserving file moves/splits.
   - No taxonomy or user-facing menu behavior changes.
2. **Menu taxonomy update**
   - Phase 1B top-level menu changes, including moving Share into Project.
3. **Left browser shell**
   - Phase 2 state, persistence, resize, keyboard shortcut, workspace mount, and Media menu browser commands.
4. **Assets browser**
   - Phase 3 sample loading validation/fix, asset rows, insert, and drag support.
5. **Device browser actions**
   - Phase 4 Effects and MIDI Instruments tabs with narrow device insertion action extraction.
6. **Effects toolbar removal**
   - Phase 5 toolbar deletion and empty-state copy update after browser actions are verified.
7. **Dashboard dedupe**
   - Phase 6 duplicate quick-action cleanup with per-view checklist.

Each commit should pass:

```bash
bun run typecheck
bun run build
```

Use a tracker-only commit separately if this plan changes without code changes.

---

## Review Findings Incorporated

These findings were accepted into the plan before implementation:

1. Avoid speculative `TimelineMenuActions` before the browser exists.
   - Action modeling should happen with the browser shell so it has at least two real consumers.
2. Do not use a basic `<Show when={open}>` toggle if it resets browser state.
   - Preserve search, scroll, active tab, and expanded state.
3. Verify bottom-panel offset math before applying browser height subtraction.
   - Avoid double-subtracting `bottomPanelOffsetPx`.
4. Add a keyboard shortcut for quick browser show/hide.
5. Split browser item source from browser item category.
6. Specify the drag/drop strategy across browser and timeline DOM subtrees.
7. Make dashboard cleanup concrete by view.
8. Decide the fate of `project-media-menu.tsx` and `projects-menu.tsx` during menu extraction.
9. Verify sample loading scale before treating row virtualization as sufficient.
10. Split behavior-preserving menu extraction from user-facing menu taxonomy changes.
11. Define persistence, resize clamping, and shortcut acceptance criteria before browser implementation.
12. Keep device action extraction narrow and preserve existing permission/availability behavior.
13. Commit by independently buildable milestones instead of one uninterrupted refactor.

---

## Risk Areas

- `EffectsPanel` currently owns device creation state deeply, so extracting insert actions must stay narrow.
- Browser placement must not overlap the fixed bottom panel.
- Browser hiding must not feel destructive or reset useful state.
- Sample browser data loading may need paging before large-project support is real.
- Drag/drop must reuse existing sample insertion behavior or deliberately introduce one shared drag context.
- Shared-project write permissions must remain enforced for browser device actions.
- Moving Share into Project changes user-facing navigation and should be called out in commit messages.

---

## Validation Plan

Use the repo's standard validation commands for implementation changes:

```bash
bun run typecheck
bun run build
```

Use formatting/diff validation for tracker-only updates:

```bash
git diff --check
```

Record validation evidence in this tracker as each phase completes.

---

## Progress

- [x] Branch created from updated `master`
- [x] Current menu/dashboard/sidebar/effects code inspected
- [x] Ableton, monorepo-new, and DialKit patterns reviewed
- [x] Combined plan and review feedback captured in this tracker
- [x] Phase 1A: Behavior-preserving menu extraction
- [x] Phase 1B: Menu taxonomy update
- [x] Phase 2: Left browser shell and real menu/browser actions
- [ ] Phase 3: Assets tab
- [ ] Phase 4: Effects and MIDI Instruments tabs
- [ ] Phase 5: Remove EffectsPanel toolbar
- [ ] Phase 6: Dashboard cleanup

---

## Validation Log

- Phase 1A: Extracted existing File, Edit, Project, Media, Settings, Tracks, and Share menu components into `src/components/timeline/menus/` without taxonomy or user-facing behavior changes. Moved `projects-menu.tsx` to `menus/project-menu.tsx` and `project-media-menu.tsx` to `menus/media-menu.tsx`; removed the old parallel files. Validation passed with `bun run typecheck` and `bun run build`.
- Phase 1B: Applied the target top-level taxonomy by removing the top-level Share menu, moving copy share link into Project, moving file/archive/account actions into File, moving keyboard shortcuts entry into Edit, and narrowing Media to detailed samples/export dashboard entries until the browser shell phase. Validation passed with `bun run typecheck` and `bun run build`.
- Phase 2: Added a persistent left browser shell with open state, width, active tab, per-tab search, and per-tab scroll saved to local storage. Mounted it as a sibling of the timeline scroll area so the timeline continues using its existing bottom-panel scroll padding, while the browser visual height subtracts the fixed bottom panel footprint once. Added left-edge resize clamping against right sidebar width and the minimum timeline width, Media menu browser commands, and `Ctrl/Cmd + Alt + B` timeline-scoped browser toggle. Validation passed with `bun run typecheck` and `bun run build`.
