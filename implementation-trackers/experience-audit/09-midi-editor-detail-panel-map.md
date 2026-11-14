# 09 — MIDI editor → bottom detail panel: code map

Scope: read-only map for DV-06 (dock the MIDI editor beside Effects/Clip) and DV-03 (velocity lane).
Branch `production-dsp-characterization`, 2026-10-15. Citations are `file:line`. No repo files were edited.

## 0. Key findings

1. The MIDI editor is a floating absolute card (`MidiEditorCard.tsx:676-689`). It opens by double-click or context menu on MIDI clips, not from the bottom panel.
2. The bottom panel has two modes, `effects` and `sample-detail` (`bottom-panel-layout.ts:5`). Its Clip tab is audio-only: `isTimelineSampleDetailClip` returns false for any clip with `midi` (`useTimelineSampleDetailController.ts:33-35`). For a MIDI clip the Clip tab is disabled (`Timeline.tsx:2300`).
3. Velocity exists in the model and in the persistence `update` op (`midi-editor-grid.ts:8`, `editor-persistence.ts:19`). The card never draws or edits it. The card uses velocity only as an audition argument (`MidiEditorCard.tsx:193,258,290`).
4. Note edits are not undoable. The card writes only via `saveSoon` (`MidiEditorCard.tsx:186,194,308`). Neither `useMidiEditorPersistence.ts` nor `lib/midi/editor-persistence.ts` calls history.
5. The card has no zoom and no horizontal scroll. Columns are fitted to clip length (`midi-editor-grid.ts:89`). It takes `bpm`, `gridDenominator`, `clipDurationSec`, not `pixelsPerSecond` (`MidiEditorCard.tsx:20-43`).
6. Open state is in memory. Only the card bounds and the keyboard toggle persist to localStorage (`useTimelineMidiOverlay.ts:116-140`). Bottom-panel open/mode are in memory (`useTimelineBottomPanelState.ts:14-15`). Only its height persists (`bottom-panel-preferences.ts:6,25-32`).
7. `/private/tmp/ableton-ui-reference` does not exist. There are no Ableton images in the repo, so DV-03 and DV-06 have no visual reference.
8. Delete/Backspace from the card is not excluded from the global timeline handler (`useTimelineKeyboard.ts:196-200`), because the card does not set `data-timeline-keyboard-local` (`keyboard-event-target.ts:8-10`). Not verified in a browser.

## 1. The floating MIDI editor today

### 1.1 Files (wc -l)

| File | Lines | Role |
|---|---:|---|
| `src/components/midi/MidiEditorCard.tsx` | 692 | Card: header, mappings, piano gutter, grid, notes, drag, resize |
| `src/components/timeline/timeline-overlays.tsx` | 238 | Mounts card (`:212-233`) in track area |
| `src/hooks/useTimelineMidiOverlay.ts` | 626 | `midiEditorClipId`, `midiCard` bounds, open/close, audition, MIDI input |
| `src/hooks/useMidiEditorPersistence.ts` | 136 | Reactive wrapper: `saveSoon`, `flush`, `canPersist`, error |
| `src/lib/midi/editor-persistence.ts` | 583 | Op union, apply/reconcile, local vs Convex commit |
| `src/lib/midi-editor-grid.ts` | 203 | Pure grid math: cells, percent positions, drag math |
| `src/lib/timeline-midi-bounds.ts` | 53 | Card bounds clamp and drag arithmetic |
| `src/hooks/useDrag.ts` | 118 | Pointer capture, window listeners, Escape/blur cancel |
| `src/components/timeline/timeline-workspace.tsx` | 742 | Double-click routing (`:410-416`), overlay mount (`:504`) |
| `src/components/Timeline.tsx` | 2724 | Hook wiring (`:1119-1137`), `midi` prop (`:2614-2627`) |
| `src/components/timeline/ClipComponent.tsx` | 689 | Dblclick (`:191`), menu item (`:196`), MIDI thumbnail (`:323-384`) |
| `src/hooks/useTimelineActions.ts` | 723 | `jumpToClip` calls `openMidiEditorFor` (`:684-687`) |
| `src/lib/timeline-midi-rendering.ts` | 37 | Clip-level MIDI projection (no velocity) |
| `packages/shared/src/midi.ts` | 291 | Note schema, `velocity` optional (`:21,27`) |

### 1.2 Component tree and props

```
Timeline.tsx (midi={...} :2614) → timeline-workspace.tsx (midi prop :179-191) → TimelineOverlays (:504)
  → <Show when={midiClip()}> → MidiEditorCard (timeline-overlays.tsx:212-231)
      root div (:676-689, absolute z-50, bounds style)
        renderHeader (:321)  renderMappings (:401)  renderBody (:659)
          renderPianoGutter (:588)  renderGridCells (:621)  renderNotes (:631)  resizer (:668)
```

Props (`MidiEditorCard.tsx:20-43`): `clipId`, `bpm`, `gridDenominator`, `clipDurationSec`, `bounds`, `onClose`, `onChangeBounds`, `midi?`, `userId?`, `canWrite`, `onAuditionNote?`, `projectId?`, `midiKeyboard`, `onLocalMidiSaved?`, `trackId?`, `effectInstances?`.

Overlay props (`timeline-overlays.tsx:47-60`): `midi.{clipId, card, userId, projectId, canWrite, close, changeBounds, auditionNote, keyboard, onLocalMidiSaved}`.

### 1.3 State

- Card signals: `notes` (`MidiEditorCard.tsx:46`), `mappings` (`:47`), `lastCreatedNoteLength` (`:48`).
- Non-reactive refs: `dragNote` (`:119`), `projectedNotes` (`:120`), `gridRef` (`:170`), `boundsDrag`/`boundsAtDragStart` (`:55-56`).
- Sync effect copies normalized `props.midi` and the persistence projection into `notes` (`:143-168`). It keeps the drag draft (`:162-165`).
- Hook signals (`useTimelineMidiOverlay.ts`): `midiEditorClipId` (`:91`), `midiCard` (`:94-96`, default `{x:80,y:80,w:720,h:360}`).

### 1.4 Open and close

Opens (all reach `openMidiEditorFor`, `useTimelineMidiOverlay.ts:271-277`, which ignores clips without `midi`):
- Double-click: `ClipComponent.tsx:191` → `timeline-workspace.tsx:410-413`.
- Context menu "Open MIDI editor": `ClipComponent.tsx:196`.
- `jumpToClip`: `useTimelineActions.ts:684-687`. It also selects the clip (`:685`).
- Guard: `canOpenMidiEditorFor` blocks the provisional clip (`Timeline.tsx:1137`).

Closes:
- ✕ button: `MidiEditorCard.tsx:369-376` → `closeMidiEditor` (`useTimelineMidiOverlay.ts:269`).
- Auto-close when the clip is gone or has lost `midi`: `useTimelineMidiOverlay.ts:392-399`.
- No Escape close and no click-outside close.

Selection does not drive the card. It stays open across selection changes.

### 1.5 Positioning, dragging, resizing, z-index

- Root: `position:absolute`, `z-50`, `left/top/width/height` from `props.bounds` (`MidiEditorCard.tsx:677-679`). Containing block: track-area wrapper (`timeline-workspace.tsx:480-486`).
- Header drag: `onHeaderPointerDown` (`:122-126`) → `useDrag` (`:90-99`) → `onChangeBounds(drag.moveTo(pos))`. Math: `timeline-midi-bounds.ts:37-46`.
- Resize: 16px corner handle (`MidiEditorCard.tsx:668-672`), `onResizerPointerDown` (`:128-132`), `useDrag` (`:101-110`), math `timeline-midi-bounds.ts:47-52`.
- Clamp: `clampTimelineMidiBounds` defaults to `window.innerWidth/innerHeight` (`timeline-midi-bounds.ts:15-18`), not the track area. Min w 320, min h 200 (`:20-21`).
- Persist: `changeMidiCardBounds` (`useTimelineMidiOverlay.ts:279-284`) → `schedulePersistMidiCard` (`:126-140`, 250 ms `window.setTimeout`).
- Escape or blur during a header/resize drag cancels and restores (`useDrag.ts:56,79-84`, `MidiEditorCard.tsx:65-68`).
- z-index: card `z-50` (`MidiEditorCard.tsx:678`). Bottom panel shell also `z-50` (`TimelineBottomPanelShell.tsx:52`). Stacking contexts not traced.

### 1.6 Focus, shortcuts, Escape

- Root stops `pointerdown`, `click`, `wheel` and prevents `contextmenu` (`MidiEditorCard.tsx:680-683`). Keydown is not stopped.
- Escape is handled only during a note drag: window-capture listener (`:216-220`, registered `:251`), cancel restores `projectedNotes` (`:210-214`).
- Global keys: `useTimelineKeyboard.ts` window-capture (`:204-209`). Returns early for editable, dialog, or menu targets (`:55-59`). Space (`:191-195`) and Delete/Backspace (`:196-200`) run unless the path has a local marker (`keyboard-event-target.ts:8-10`), which only `EffectsPanel.tsx:830` and `automation-lane.tsx:373` set.
- Hardware MIDI keyboard listeners: `useMidiKeyboardInput.ts:184-185`. Editable handling not traced.

### 1.7 Note editing

- Create: click empty cell (`onGridClick`, `:175-196`). Velocity `0.9` (`midi-editor-grid.ts:106`), length = last created or one step (`MidiEditorCard.tsx:190-191`), audition (`:193`), save `insert` (`:194`).
- Delete: click occupied cell (`:184-187`) or double-click note (`renderNotes` `:646-651`).
- Move/resize: `onNotePointerDown` (`:221-259`). Right 30% of a note starts resize (`:233`), else move. Grid captures pointer (`:254`). Window listeners (`:248-252`). Move/up/cancel: `:260-315`.
- Commit on pointer-up: `update` with `{length}` (resize) or `{beat, pitch}` (move) (`:304-309`). Velocity is never written.
- Audition: gutter press (`:606-609`, literal 0.9), drag (`:258,290`).
- Mappings UI (`:401-586`), input channel select (`:333-351`), error retry/dismiss (`:352-367`). All write via `saveSoon`.

### 1.8 Undo

None for note edits. `src/lib/undo/types.ts` has no note-level entry. `midi?: any` appears only in clip-snapshot-shaped fields (`:36`, `:229`, `:304`). Deleting a whole MIDI clip is undoable through those. Note edits are not.

### 1.9 Playhead, scroll, zoom

- Playhead: drawn by `TimelineOverlays` (`timeline-overlays.tsx:206-211`). The card has none.
- Zoom: none. Horizontal scroll: none (`midi-editor-grid.ts:89`, `minmax(0,1fr)`).
- Vertical scroll: body `overflow-y-auto` (`MidiEditorCard.tsx:661`). Body height `calc(100% - 66px)` (`:660`), a hard-coded header+mapping offset.
- Wheel is stopped (`:682`), so the timeline does not scroll over the card.

### 1.10 Persistence of open state and size

- Open state / `midiEditorClipId`: memory only (`useTimelineMidiOverlay.ts:91`). Reload closes the card.
- Bounds: `mb:midi_card:${projectId}` (`:121-123`), written 250 ms after change (`:126-140`), read in effect (`:372-383`).
- Keyboard toggle: `mb:midi_kb:${projectId}` (`:116-119`, `:401-419`).
- Notes: via persistence adapter (§6).

### 1.11 Tests

- `src/components/midi/midi-editor-persistence.browser.test.ts` (226): mounts card with `bounds` (`:41-53`). Selectors `.absolute.inset-0.grid > .relative` (`:72`), `[data-midi-note="1"]` (`:86`), text "MIDI save failed — Retry" (`:87`). Screenshot to `acceptance-reports/` (`:210`).
- `src/hooks/pointer-gesture-ownership.browser.test.ts` (2377): fixture mounts card with `bounds`, `onChangeBounds` (`:2248-2264`), stubs persistence (`:2302`). Uses `a.parentElement.parentElement` (`:2266`), `[data-midi-note]` (`:2236`), `hasPointerCapture` (`:2281`). Test at `:2300`, Escape scenario at `:2336`.
- `src/hooks/useTimelineMidiOverlay.test.ts` (160): source-text assertions (`:122-135`), including ordering inside `removeNativeLiveMidiReset` and the `closeMidiEditor` declaration.
- `src/lib/midi/editor-persistence.test.ts` (261), `src/lib/midi-editor-grid.test.ts` (34), `src/hooks/useMidiEditorPersistence.test.ts` (9).
- `src/components/timeline/timeline-panels-boundary.test.ts` (28): asserts `<TimelinePanels panels={props.panels} />` (`:22`) and `panels = () => props.panels` (`:27`).
- No `data-testid` on the card. Selectors are aria-labels: "Close MIDI editor" (`:373`), "MIDI input channel" (`:337`), "Add MIDI mapping" (`:408`).

## 2. The bottom panel today

### 2.1 Modes and footer

- Mode type `"effects" | "sample-detail"` (`bottom-panel-layout.ts:5`). Mode signal default `"effects"` and open default `true` (`useTimelineBottomPanelState.ts:14-15`).
- Footer (`TimelineBottomPanelFooter.tsx`): `activeTab: "effects" | "clip"` (`:7`). Effects tab `:26-34`. Clip tab `:35-44`, disabled when inactive and no `onClipTabClick` (`:40`). Hide/Show `:46-54`. Height 28 px (`bottom-panel-layout.ts:3`).
- Mounting is by mode: `Timeline.tsx:2292` (effects `isOpen`), `:2429` (sample-detail `isOpen`).
- Clip tab: `Timeline.tsx:2299-2306`, `canOpen: Boolean(sampleDetail.selectedClip())` (`:2300`), `onOpen` sets sample-detail.
- Audio clicks switch to sample-detail: `Timeline.tsx:2589-2603`. Hide returns to effects: `:2446-2449`.

### 2.2 Layout, resize, stored height

- Shell (`TimelineBottomPanelShell.tsx`, 76): `fixed bottom-0 … z-50` (`:52`). Content height = `heightPx` (`:68-70`). Footer after content (`:71`).
- Handle: top-edge button, 16 px hit area, `cursor-ns-resize` (`:55-66`). Double-click resets to default (`:60`). Escape restores start height (`:31-35`).
- Default height `FX_PANEL_HEIGHT_PX = 360` (`timeline-utils.ts:20`). Min 360, max `max(360, floor(0.5 × viewport))` (`bottom-panel-preferences.ts:4,8-12`). Stored at `bottom-panel-height:${scope}` (`:6,25-32`), loaded at `useTimelineBottomPanelState.ts:24-27`.
- Track inset: `heightPx + 28 + 4` when open (`bottom-panel-layout.ts:12-17`, `useTimelineBottomPanelState.ts:19`). Track area reads it (`timeline-workspace.tsx:427,484`).

### 2.3 Clip for MIDI vs audio

- Audio: `SampleDetailPanel.tsx` (77) shows "Sample Detail" (`:49`), `SampleClipPanel` (`:52-63`), `SampleDetailWaveform` (`:64-71`).
- MIDI: nothing. `selectedClip` is undefined for MIDI (`useTimelineSampleDetailController.ts:45-51`, `:34`).

### 2.4 Selection

- Sample detail is selection-driven and auto-closes when no eligible clip is selected (`useTimelineSampleDetailController.ts:58-62`).
- The MIDI card is explicit-open and not selection-driven (§1.4).

### 2.5 Effects panel mount

- `timeline-panels.tsx` (259) renders `EffectsPanel` (`:169-213`) and `SampleDetailPanel` (`:215-233`), each gated by `isOpen`. No tab logic. Props contract `:28-122`.
- `EffectsPanel.tsx` (1360) renders its own shell (`:1267-1350`) and a closed footer (`:1354`). Clip-tab props at `:149`, `:161-165`.

### 2.6 Focus and keys

- No focus management. Shell window listeners are drag-only (`TimelineBottomPanelShell.tsx:36-40`).
- Sample-detail Escape: `useTimelineSampleDetailController.ts:64-74` (window capture, skips editable targets and marker drags).
- No Tab-key handling in non-test `src` (grep).

### 2.7 Ableton toggles

- Only Effects/Clip tabs and Hide/Show (`TimelineBottomPanelFooter.tsx:26-54`). No Shift+Tab, no view-switch key. "View" is only the top menu (`menus/view-menu.tsx`), not a bottom-panel tab.

## 3. Audio clip editing

Yes, all in sample-detail mode:
- `SampleClipPanel.tsx` (272): Warp toggle (`:99-103`), Source BPM (`:108`), Project BPM (`:123`), repitch/stretch (`:138`), Auto BPM and Apply Source BPM (`:190-244`), Clip Gain dB slider (`:252-264`).
- `SampleDetailWaveform.tsx` (525): warp markers. Double-click adds (`:190-199`, `:363`). Delete selected (`:201-205`). Pointer-capture drag (`:393-438`). Escape cancels marker drag (`:501`).
- Writes: `onWarpChange` → `audioWarpController.changeAudioWarp` (`useTimelineSampleDetailController.ts:97-99`). `changeGain` (`:76-95`) pushes history (`:88-93`).
- Start/end trim is not in these panels. It is timeline-level (`hooks/useClipResize.ts`), not traced here.

## 4. Velocity today

- Model: `MidiEditorNote.velocity?: number` (`midi-editor-grid.ts:8`). Shared schema `velocity` optional (`packages/shared/src/midi.ts:21,27`).
- Op: `update` accepts `velocity` (`editor-persistence.ts:19`). Apply (`:251`), reflection (`:172`), coalesce (`:297`) handle it. No caller writes it.
- Creation default `0.9` (`midi-editor-grid.ts:30,106`). Equality includes velocity (`:184`).
- Card render: none. Notes are fixed `bg-green-500/70` (`MidiEditorCard.tsx:636`).
- Clip thumbnail render: none (`ClipComponent.tsx:349-380`).
- Playback: sampler maps velocity to zones (`packages/audio-engine/src/sampler-runtime.ts:256,292,334`). Other instruments not traced.
- Command path: `saveSoon` (`useMidiEditorPersistence.ts:97-109`) → `enqueue` (`editor-persistence.ts:551-556`) → `flush`/`attemptOperations` (`:435-480`) → `clip.midi.set` with the full `notes` array (`:320-332`, `:325`). No undo entry (§1.8).

## 5. Ableton reference

- `/private/tmp/ableton-ui-reference`: does not exist. `/tmp` has no matching folder.
- Repo: "ableton" matches are in docs, trackers, and acceptance reports (plus one `audio-engine.ts` comment, not inspected). No reference images.
- DV-06/DV-03 are at `implementation-trackers/experience-polish-tracker.md:188-191`.

## 6. Risks and coupling

Floating → docked:
- Absolute root and bounds (`MidiEditorCard.tsx:677-679`). Bounds clamp to window, not track area (`timeline-midi-bounds.ts:15-31`).
- Hard-coded body height `calc(100% - 66px)` (`:660`). Mappings can grow (`:423` `max-h-24`), so 66 px is likely wrong with mappings open. Verify.
- Pointer capture (`:254`), window listeners (`:248-252`), `lostpointercapture` (`:255`). These are position-independent.
- Root stops propagation (`:680-683`). Docked, the event path changes. Verify.
- Global keys: Delete/Backspace may reach the clip-delete path (`useTimelineKeyboard.ts:196-200`) from card body focus. Not verified. Verify before docking.
- Escape: sample-detail Escape (`useTimelineSampleDetailController.ts:64-74`) and the card's note-drag Escape (`MidiEditorCard.tsx:216-220`) are both window-capture listeners. Docking into the same mode makes their interaction matter. Verify.
- Mode semantics: Clip tab and `sample-detail` are audio-only (`useTimelineSampleDetailController.ts:33-35`). Auto-close (`:58-62`) must allow MIDI clips.
- Live MIDI target: `resolveTargetTrack` gives `midiEditorClipId` priority (`useTimelineMidiOverlay.ts:150-153`). Channel filter (`:430-437`) and mapping index (`:175-178`) use it too. If docked editing is selection-driven, this source changes.
- Auto-close on lost MIDI (`:392-399`) must survive.
- Timers: `schedulePersistMidiCard` uses `window.setTimeout` (`:126-140`). Removing bounds code removes one.

Tests to update:
- `midi-editor-persistence.browser.test.ts:41-53,72,86-87`.
- `pointer-gesture-ownership.browser.test.ts:2248-2266,2281,2300,2336`.
- `useTimelineMidiOverlay.test.ts:122-135` (source-text).
- `timeline-panels-boundary.test.ts:12-27`.

Collaboration and Convex:
- Local: `createLocalControlService` with `excludePendingWriteKinds: ['midi']` (`editor-persistence.ts:377-384`), flushed via `registerPendingLocalProjectWriteFlusher` (`:543`).
- Remote: `snapshotV2` query (`:429`), `commitV1` mutation (`:452`), idempotency key (`:441`). Revision conflict retries once (`:474-477`). Ops re-applied to fresh snapshot (`:440`), but every commit sends the whole notes array (`:325`).
- Overlay: pending ops projected over props (`:536-540`, `:561-566`). Remote echoes reconciled (`:398-424`).
- Docking does not change this path. A velocity lane reuses `update`; no schema change.

## 7. Proposed seams

1. Routing and predicate: split `isTimelineSampleDetailClip` (`useTimelineSampleDetailController.ts:33-41`) into audio and MIDI predicates. Clip-tab `canOpen` (`Timeline.tsx:2300`) and auto-close (`:58-62`) use the union. Double-click (`timeline-workspace.tsx:410-416`) sends MIDI to the same open path as audio. Recommended: selection-driven, to match Ableton Detail View. Decision for the plan.
2. Body extraction: turn the root (`MidiEditorCard.tsx:676-689`) into a body that renders header, mappings, and grid in `flex-col h-full`. Replace `calc(100% - 66px)` (`:660`) with `flex-1 min-h-0`. Drop `bounds`, `onChangeBounds`, `onClose`. Keep the rest of the props.
3. Mount: give `SampleDetailPanel` a MIDI branch, or add a sibling panel. Pass `gridDenominator`, `userId`, `projectId`, `midiKeyboard`, `onAuditionNote`, `effectInstances` through `timeline-panels.tsx:91-106` from `Timeline.tsx:2428-2450`.
4. Delete after docking:
   - `MidiEditorCard.tsx`: `cardDrag`/`resizeDrag` (`:90-110`), bounds helpers (`:55-68`), header/resizer handlers (`:122-132`), resizer (`:668-672`), absolute root styles (`:677-684`), header `cursor-move` (`:323`).
   - `useTimelineMidiOverlay.ts`: `midiCard` (`:94-96`), `schedulePersistMidiCard` (`:126-140`), `changeMidiCardBounds` (`:279-284`), bounds read (`:372-383`), `midiCardStorageKey` (`:121-124`).
   - `timeline-midi-bounds.ts` (53): only consumers are the card, the hook, and types (`timeline-overlays.tsx:6`, `timeline-workspace.tsx:28`).
   - Props: `timeline-overlays.tsx:47-60,212-232`, `timeline-workspace.tsx:179-191`, `Timeline.tsx:2614-2627`.
5. Velocity lane (DV-03):
   - Fixed-height row under the grid, outside the `overflow-y-auto` body (`MidiEditorCard.tsx:661`), so vertical scroll does not move it.
   - Same two-column template as the body (`:661`): gutter cell 44px as label, right cell with `columnTemplate` (`midi-editor-grid.ts:89`).
   - Bars align with notes using `noteLeftPercent`/`noteWidthPercent` (`midi-editor-grid.ts:96-97`). No shared scroll is needed today. If horizontal zoom is added, grid and lane must share one scroll container.
   - Height = velocity 0..1. Legacy notes without velocity need a default (same as `:106`).
   - Edit: drag on lane → `update` with `{velocity}` on pointer-up (`editor-persistence.ts:19`). Stop propagation so `onGridClick` (`MidiEditorCard.tsx:175-196`) does not fire. Consider `useDrag` (`hooks/useDrag.ts`, tracker XC-08) for capture and Escape.
   - Optional opacity on notes (`MidiEditorCard.tsx:636-643`). Design decision.
6. Keys: before docking, add a local marker to the editor body (`keyboard-event-target.ts:8-10`) so Delete/Backspace inside it does not reach clip delete (`useTimelineKeyboard.ts:196-200`). Make the sample-detail Escape handler (`useTimelineSampleDetailController.ts:64-74`) skip while a note drag is active.

## 8. Open questions for the plan

1. Selection-driven or explicit open for the docked editor? (§7.1)
2. Keep the `sample-detail` mode name or rename to a clip-detail mode? (§7.1)
3. Provide the Ableton reference folder, or confirm target visuals. (§5)
4. Confirm the Delete/Backspace risk in a browser before docking. (§6)
5. Velocity lane height, and whether notes also change opacity. (§7.5)
