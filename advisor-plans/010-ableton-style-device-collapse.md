# Ableton-style device collapse

## Goal

Allow every built-in device and external VST device in the effects panel to
toggle between its current expanded horizontal presentation and a slim vertical
collapsed rail.

Supported interactions:

- chevron button in the device title bar;
- `Collapse Device` / `Expand Device` context-menu action;
- double-click on a non-interactive title/header region;
- touch double-tap using the repository's existing timing/distance convention.

## State ownership

Add panel-owned, project-scoped local UI state keyed by stable device identity.
Do not put collapse state in DSP parameters, effect rows, Convex schemas,
desktop protocol, native VST state, or undo history.

Identity:

- arpeggiator: target plus fixed arpeggiator key;
- built-in instrument: instrument `instanceId`;
- built-in audio effect: effect row ID;
- external instrument/effect: processor `instanceId`.

Persist the collapsed identity set locally per project/profile. Default to
expanded. Keep stale deleted identities harmless rather than adding pruning.

## Component shape

1. Add a focused collapse preference/controller helper.
2. Create the controller once in `EffectsPanel`.
3. Wrap each rendered device with a small collapse context containing:
   - `collapsed: Accessor<boolean>`;
   - `toggle(): void`;
   - stable content ID.
4. Let `EffectShell` consume that context and own the common visual treatment.
   Do not add collapse props through every device component.
5. Keep context-menu composition in `EffectsPanel`, where device identity and
   existing enable/reset/delete actions are already known.

## Visual behavior

Expanded devices retain their current dimensions and content.

Collapsed devices:

- use a fixed 32px width and full panel height;
- show the chevron, vertically oriented device title, and existing On/Off state
  where supported;
- hide type text, reset/custom header actions, parameters, and editor body;
- keep the body mounted but use `hidden` so local visual state survives and
  controls leave the tab/accessibility tree;
- do not animate width;
- allow a restrained chevron rotation with reduced-motion support.

The existing measured-card reorder algorithm should continue using actual
expanded/collapsed widths.

## Interaction rules

- Chevron is a native button with `aria-expanded`, `aria-controls`, a precise
  accessible label, visible focus state, and at least a 24px target.
- Header double-click/tap excludes buttons, inputs, selects, sliders, and other
  interactive descendants.
- A drag crossing the existing reorder threshold cancels pending double-tap.
- The second recognized tap must not arm another reorder.
- Read-only collaborators may collapse devices because this is local UI state;
  domain mutations remain disabled.
- VST header interaction must not focus/open/close the native editor.
- Collapsing a VST never changes its processor attachment or editor lifecycle.
- Expanded VST body interaction retains the current native-editor focus behavior.
- Delete/Backspace ignores the chevron and other interactive controls.

## Ableton/reference grounding

- Follow Ableton's title-bar unfold control and compact vertical device rail.
- Use DialKit's controlled collapse/open-state pattern, but do not unmount
  device content.
- Follow OpenCode's separation of persisted layout preferences from domain
  state.
- Reuse the current timeline context-menu component and existing clip
  double-tap timing/distance behavior.

## Tests

- Preference parsing, project isolation, round-trip, unavailable storage.
- Stable identity across reorder and independent same-kind devices.
- Instrument replacement receives default-expanded state.
- Pure gesture classifier for mouse double-click, touch double-tap, distance,
  timeout, pointer mismatch, cancellation, and drag threshold.
- Context-menu label/action projection.
- Source-contract/component tests for shell width, hidden body, chevron ARIA,
  browser/VST coverage, read-only collapse, and VST editor-focus exclusion.
- Existing mixed-order, drag reorder, deletion, parameter, and VST tests remain
  passing.
- Manual packaged Electron verification with built-in effects, VST effects,
  VST instruments, mixed widths, open VST editor, reorder, and horizontal scroll.
