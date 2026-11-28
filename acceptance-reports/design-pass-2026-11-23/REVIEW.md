# Arrangement flow interface review (design-pass, packaged build via CDP 9333)

Scope: control bar, timeline (ruler, lanes, clips), right track headers (tracks, returns, master), bottom device panel (Synth, EQ Eight, Saturator, Compressor, Drum Rack shell) and its footer tabs; browser sidebar only as framing. Excluded: dashboard, MIDI note editor internals, export dialog. No repo files, tracks, clips or devices were changed. Only focus moves and read-only eval were done in the live app.
Project guidance read: AGENTS.md, AGENTS-solid.md, ~/.factory/AGENTS.md (Solid 2 section), docs/ableton-ui-reference/README.md. Skills applied in order: better-accessibility, better-layout, better-writing, better-typography, better-colors, better-ui, then solid-ui-code-review (Solid 2 idioms not counted as violations).
Contrast numbers are measured from rendered computed colors in the app (script /tmp/design/review/contrast.js, composited over the actual ancestor backgrounds). Where a ratio comes from my own sRGB conversion of a token, it says so.
Screenshots: /tmp/design/review/full.png, focus-transport.png, crop-transport.png, crop-solo.png, crop-sel.png. Baselines in /tmp/design/before/.

## Findings (ranked)

### 1. HIGH, Accessibility: shared Button focus ring is nearly invisible (1.48:1)
- Location: src/components/ui/button.tsx:12; src/index.css:42 (--ring), :247 (outline-ring/50)
- Current: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`, with `--ring: oklch(0.871 0.006 286.286)` on a white/near-white surface.
- Evidence: Tab through the control bar (Play, Stop, metronome, loop, snap, Follow, MIDI keyboard, Saved status). Computed ring colour is oklab(0.871 .. / 0.5). My calculation: --ring on white is 1.48:1, and at the 50 % alpha the browser applies it is about 1.2:1. /tmp/design/review/crop-transport.png (loop button focused) shows a faint grey square that is easy to miss next to the green icon. WCAG 2.4.11/1.4.11 needs 3:1.
- Why it matters: every control built on Button (transport, footer tabs, browser, dropdown triggers) is unusable by keyboard without hunting for the cursor. Largest reach in the scope.
- Fix: use the focus colour the track rows already use. In button.tsx replace the ring classes with `focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary focus-visible:ring-0` (matches the existing `.track-row-divider button:focus-visible` rule, index.css:520). Do not change --ring itself unless every consumer is rechecked.

### 2. HIGH, Accessibility: track Output and Send selects are keyboard-reachable but show no focus ring
- Location: src/components/timeline/TrackSidebarRow.tsx:583-591 (output) and the matching send select at ~629
- Current: `<select ... class="absolute inset-0 h-7 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" title=... "Track output">` over a decorative div.
- Evidence: focusing `select[title="Track output"]` gives `:focus-visible = true`, outline auto, opacity 0. crop-sel.png shows the Master/Reverb boxes with no change at all while the select has focus. Snapshot also lists "Track output" and "Track send" 12 times each with no track in the name (the name comes only from title).
- Why it matters: 24 tab stops in the track list where the user cannot see where they are, and a screen reader hears 12 identical names.
- Fix: put `focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-primary` on the wrapping `relative` div (same recipe as other track-row controls), and give each select `aria-label={\`Track ${trackNumber()} output\`}` / `... send`.

### 3. HIGH, Accessibility: BPM field has no focus indicator
- Location: src/components/timeline/TransportControls.tsx:128
- Current: `class="w-auto appearance-none border border-border bg-timeline-surface px-2 py-1 text-xs text-foreground focus:border-border focus:outline-none"`
- Evidence: focus on the BPM input reports outline-style none, box-shadow none (focus audit, 4th stop, "INPUT"). The border stays --border (1.27:1 on white) on focus, so nothing changes.
- Why it matters: the most edited text field on the screen gives no sign it is active, and Enter/blur commits the tempo.
- Fix: replace `focus:border-border focus:outline-none` with `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary`.

### 4. HIGH, Accessibility: track collapse/expand button is named by a glyph and exposes no state
- Location: src/components/timeline/TrackSidebarRow.tsx:507-519 (same pattern in MasterSidebarRow.tsx:205)
- Current: `<button ... title={track.collapsed ? "Expand track" : "Collapse track"}>{track.collapsed ? "▶" : "▼"}</button>`, no `type`, no aria-label, no aria-expanded.
- Evidence: agent-browser snapshot lists 12 buttons named "▼" (and "▶" for returns). Per-row check showed it is 16x28 px.
- Why it matters: screen reader users get "black down-pointing triangle" with no track name and no collapsed state. Pointer users also get a 16 px wide target.
- Fix: add `type="button"`, `aria-expanded={!track.collapsed}`, `aria-label={\`${track.collapsed ? "Expand" : "Collapse"} track ${trackNumber()}\`}`, and `aria-hidden="true"` on the glyph (or use the existing Icon). Keep the title.

### 5. HIGH, Colors: white text on the amber "active" fill fails contrast, shared device toggle
- Location: src/components/ui/device-control.tsx:18 (`bg-amber-400 text-background`); same pair appears in Saturator mode tabs and Compressor mode toggles.
- Evidence: rendered white text on rgb(255,185,0) measures 1.72:1 for "Soft", "Transfer", "RMS", "Compress", "Log" at 10 px (contrast script; also visible in /tmp/design/before/02-drums-devices.png). Needs 4.5:1. Note: --background is white in the light theme, so "text-background" is not dark here as it would be in dark mode.
- Why it matters: the selected mode is the one thing the user needs to read, and the active state is also carried only by that fill.
- Fix: use a dark foreground on the amber, as the track number buttons already do (TrackSidebarRow.tsx:692 uses `bg-amber-400 text-black`): `'bg-amber-400 text-black'`. This repairs every consumer of DeviceToggleButton at once.

### 6. HIGH, Colors: device "On" and cyan text fail contrast
- Location: src/components/effects/EffectShell.tsx:188-195 (`bg-cyan-500/10 text-cyan-300`), :205-207 (collapsed variant); src/components/effects/Synth.tsx:89, 424, 490 (`bg-cyan-500/20 text-cyan-200`); src/components/effects/Compressor.tsx:66 (`text-yellow-300` / `text-cyan-300` readouts)
- Evidence: rendered pairs from the contrast script: "On" 12 px cyan on pale cyan 1.26:1 (three devices); Synth "On" 10 px 1.02:1; Amp Env / LFO selected tabs 1.05:1; Compressor "0.0 dB" yellow 1.32:1 and "-20.0 dB" cyan 1.43:1. Dark-theme colours (300/200 steps) are used on a light surface.
- Why it matters: device power state, selected tab and the compressor threshold/output readouts are close to invisible in the light theme. (Some Synth pairs may be inflated by a translucent background I composited; the EffectShell and Compressor ones are opaque-background and reliable. Confirm after fix.)
- Fix: pick the 700 step for light and keep the 300/200 step under `dark:`: e.g. `text-cyan-700 dark:text-cyan-300`, `text-yellow-700 dark:text-yellow-300`. Better: add a semantic `--device-on-foreground` token beside --info-foreground in index.css so there is one place to change.

### 7. MEDIUM, Colors: Return (R) and Automation (A) track buttons and collapse triangles are low contrast
- Location: src/components/timeline/TrackSidebarRow.tsx:757 (`border-red-500 text-red-400`), :857-860 (`text-red-300`), :509 (`text-muted-foreground` triangle on coloured track)
- Evidence: contrast script: "R" red-400 on the header grey 2.42:1 (11 buttons), "A" red-300 on 1.43:1 (13 buttons), collapse triangles on coloured track headers 1.98 to 3.29:1. See crop-solo.png.
- Why it matters: arm and automation are core arrangement controls; the label letters are at 12 px.
- Fix: `text-red-600` for R and A in light theme (keep -400/-300 with `dark:`), and `text-foreground/70` for the triangle.

### 8. MEDIUM, Accessibility: grid dropdown nests a button in a button
- Location: src/components/timeline/TransportControls.tsx:215-219 (`<DropdownMenuTrigger><Button ...>{\`1/${...}\`}</Button></DropdownMenuTrigger>`)
- Evidence: DOM is `<button id="dropdownmenu-cl-0-trigger" aria-haspopup aria-expanded><button ...>1/4</button></button>`. Tab hits "1/4" twice (focus audit rows 9 and 10); the second has no ring and the inner button has no menu semantics. Neither has a name beyond "1/4".
- Why it matters: duplicate tab stop, invalid HTML, and a screen reader cannot tell the control sets the grid.
- Fix: use the repo's pattern from TopRightIconButton: `<DropdownMenuTrigger as={Button} variant="ghost" size="sm" aria-label="Grid size" class={nativeMenuTriggerClass}>`. Add `aria-label`.

### 9. MEDIUM, Accessibility: device "On/Off" header button has a generic name and no pressed state
- Location: src/components/effects/EffectShell.tsx:186-197
- Current: `<button class="flex w-9 ... text-xs ..." title=... >{props.enabled ? 'On' : 'Off'}</button>` with no type, no aria-label, no aria-pressed, no focus style; the collapsed variant (line 208) does have aria-label.
- Evidence: snapshot lists three buttons named just "On" (EQ, Saturator, Compressor). Focus state at runtime was not tested for this button; in source it has no focus-visible classes, so it falls back to the browser default (and the shell chevron next to it has its own cyan ring).
- Fix: copy the collapsed variant: `type="button" aria-pressed={props.enabled} aria-label={\`${props.enabled ? 'Disable' : 'Enable'} ${props.title}\`}` and add the shell chevron's ring (`focus-visible:ring-1 focus-visible:ring-inset`), but with a visible colour (see finding 1).

### 10. MEDIUM, Layout/Accessibility: S, R, A and + buttons are 15x20 px with 4 px gaps
- Location: src/components/timeline/TrackSidebarRow.tsx:680-682 (`grid-template-columns: "3fr 1fr 1fr"`, `gap-1`), h-5 at :687, :719, :752, :855, :881
- Evidence: bounding boxes from the live DOM: Solo 15x20, Arm 15x20, Show automation 15x20, Add automation lane 15x20; return rows 12x20. Adjacent targets are 4 px apart so the 24 px target-spacing exception does not apply (WCAG 2.5.8).
- Why it matters: Solo/Arm are the most-clicked buttons in the header and are easy to mis-hit (solo vs. arm side by side).
- Fix, no redesign: change columns to `"1fr 24px 24px"` and `h-6`, or extend the hit area with `before:absolute before:-inset-x-0.5 before:inset-y-0` without changing the look.

### 11. MEDIUM, Typography: 10 px (text-2xs) is used for everything in devices, 3xs 8 px exists
- Location: src/index.css:6-11 (`--text-2xs: 0.625rem`, `--text-3xs: 0.5rem`); src/components/ui/device-control.tsx:17, 39; 29 `text-2xs/3xs` uses under src/components/effects/; EffectShell.tsx:153 `text-[10px]`; TimelineBottomPanelFooter.tsx:16, 50 `text-[11px]`
- Evidence: font-size census of the live DOM: 10 px on 59 text nodes, 11 px on 19, 8 px on 4 (at 2056 px wide). Knob value readouts, mode buttons and device type labels are all 10 px, and the 8 px nodes are not readable at normal viewing distance.
- Why it matters: dense is expected for a DAW, but 8 px and muted 10 px text together are the cause of several contrast failures above.
- Fix: stop at 10 px minimum (remove or raise text-3xs uses to text-2xs), and do not use `text-muted-foreground` at 10 px on grey surfaces (measured 4.05:1 on rgb(235,235,236) for the EQ band numbers and automation "+", below 4.5:1).

### 12. MEDIUM, Layout: device chain overflows horizontally with no cue
- Location: src/components/timeline/EffectsPanel.tsx:1074 (`class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-1 py-1"`)
- Evidence: scrollWidth 2520 / clientWidth 2056 and scrollbar height 0 (overlay scrollbar). In /tmp/design/before/03-bass-devices.png and full.png the Compressor is cut mid-card at the right edge ("Compressor" title, Ratio and Attack knobs) with no fade, arrow or visible scrollbar.
- Why it matters: users can believe the chain ends there (better-layout: hidden content needs a cue). Ableton shows a horizontal scrollbar in the device chain.
- Fix: keep `overflow-x-auto` but force a visible thin scrollbar on this container (existing scrollbar utility if the repo has one) or add `[scrollbar-gutter:stable]`; at minimum add an edge fade `mask-image` on the trailing edge.

### 13. LOW, Accessibility: footer tabs are not tabs and the disabled "Clip" tab is muted
- Location: src/components/timeline/TimelineBottomPanelFooter.tsx:15-18, 26-45, 50
- Current: three `Button`s: Effects, Clip, and a toggle with `toggleLabel`. `tabClass` only changes colour; no `role="tab"`/`aria-selected`/`aria-pressed`.
- Evidence: snapshot "EFFECTS", "CLIP" [disabled], "HIDE": no selected state exposed. Disabled "Clip" text measures 1.98:1, but it is disabled so exempt from contrast; the active vs. inactive difference is only background `bg-muted` (1.1:1) and colour.
- Fix: add `aria-pressed={props.activeTab === "effects"}` and the same for Clip. Add a bottom-border or underline for the active tab so state does not depend on a near-white fill.

### 14. LOW, Writing: copy inconsistencies in track controls
- Location: src/components/timeline/TrackSidebarRow.tsx:697-708 vs 728-746 vs 766-776; TransportControls.tsx:170, 180, 193, 206
- Evidence: the same button gets three label styles: mute is "Deactivate track 1" (title "Deactivate track 1", but text "1"), solo is "Solo track 1" with title "Solo", arm has title "Arm for recording". Transport uses "Toggle metronome", "Toggle loop region", "Toggle snap to grid", "Toggle Follow" (verb plus capitalised feature name). Ableton calls these Track Activator, Solo, Arm, Metronome, Loop, Draw Mode/Snap.
- Fix: names should state the control, state comes from aria-pressed: "Metronome", "Loop region", "Snap to grid", "Follow". Make titles match the names (title "Solo track 1").

### 15. LOW, Solid: single source of an unkeyed inline effect pattern in rows (no violations found)
- Review of TrackSidebarRow.tsx, TransportControls.tsx, EffectShell.tsx, device-control.tsx: no destructured props, no `.map` in JSX, For/Show used, object class arrays used, cleanup handled. One small item: `DeviceToggleButton` (device-control.tsx:22) writes `aria-pressed={props.active === true ? "true" : "false"}` and the same string-ternary pattern is repeated in ~15 places (TransportControls.tsx:73, 169, 179, 192, 205; TrackSidebarRow.tsx:696, 727, 760); Solid 2 accepts a boolean here. Cosmetic only.

## Inspected
- Live: baseline screenshots; full interactive snapshot (all buttons, sliders, tabs, selects with names); name and size audit of every interactive element (/tmp/design/review/audit1.js); computed focus state over 34 Tab stops from the record button through the Synth device (focus.js); rendered contrast for every text node (contrast.js); focus screenshots for loop button, Solo, Output select; horizontal overflow of the device chain; font-size census.
- Source: Timeline.tsx (only grep for scope), TrackSidebarRow.tsx (506-780, 850-900), TransportControls.tsx, EffectShell.tsx, device-control.tsx, button.tsx, TimelineBottomPanelFooter.tsx, index.css tokens, Synth.tsx tab code, Compressor readouts.

## Not inspected or not verified
- Narrow widths and 200 % zoom: the packaged Electron window cannot be resized without changing the user's app state, so layout at 320 px or zoomed was Not verified.
- Dark theme (only the light theme is running).
- Keyboard operation of clips and the ruler: snapshot shows clips only as a generic "clickable" element (ref e123), no role or tab stop; I did not test moving or selecting clips by keyboard, so the "clip not keyboard reachable" question is open. Likely relevant to the DAW's keyboard shortcuts, so check it.
- Timeline ruler, lane context menus, drum rack pads, EQ/Spectrum canvases and meters (canvas content has no inspectable text); reduced motion (no `prefers-reduced-motion` rules found in the loaded stylesheets, count 0, but no animation was seen to be at risk, so left as an open check).
- Screen reader output was inferred from the accessibility snapshot, not from a real screen reader.

Verdict: Block (findings 1 to 6 are HIGH).
