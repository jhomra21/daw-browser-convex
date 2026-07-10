# Audio Settings Dashboard Tracker

## Goal

Add an Ableton-inspired Audio page to the dashboard that exposes only browser and Web Audio settings the application can support reliably.

## Completion Criteria

- Existing version 1 app preferences migrate without losing appearance, agent, sidebar, or timeline settings.
- Users can select a recording input and an authorized playback output.
- Recording requests honor the selected input and supported browser-processing preferences.
- Users can request a live engine sample rate and latency mode without destroying an active audio graph.
- The page reports actual runtime sample rate and browser-reported output latency accurately.
- Output changes fail safely and a test tone verifies the current route.
- Unsupported native DAW concepts are explained rather than represented as fake controls.
- Tests, typecheck, Knip, diff checks, build, and the Chrome smoke matrix pass.

## Product Decisions

### Exposed settings

- Audio input device.
- Authorized audio output device.
- Requested engine sample rate: system default, 44.1, 48, or 96 kHz.
- Latency mode: interactive, balanced, or playback.
- Echo cancellation, noise suppression, and automatic gain control for recording.
- Read-only engine state, actual sample rate, base latency, output latency, and total output estimate.
- Output test tone.

### Explicitly out of scope

- Driver type or control-panel access.
- Hardware buffer size.
- Input/output channel matrices.
- Driver error compensation.
- Round-trip latency claims.
- CPU usage simulation.
- Rebuilding a running timeline audio graph.
- Project-scoped or cloud-synchronized audio preferences.

## Architecture Constraints

- Preserve synchronous `AudioEngine.ensureAudio()`.
- Never call `AudioEngine.close()` from Audio Settings.
- Apply constructor-bound changes to the next audio context.
- Apply output sink changes live only when supported.
- Configure the singleton globally, not only while the Audio dashboard is mounted.
- Keep device lists, labels, permissions, errors, and runtime metrics ephemeral.
- Persist unavailable device IDs rather than silently replacing them.
- Invoke output selection directly from a user event.
- Stop every permission-probe stream.
- Keep the recording preview context independent from live engine preferences.
- Use existing dashboard rows and native controls.

## Phase 1: Persisted preference contract

- [x] Advance app preferences from version 1 to version 2.
- [x] Add narrow audio preference types and defaults.
- [x] Add explicit version 1 migration preserving every existing preference group.
- [x] Normalize malformed audio fields independently.
- [x] Expose audio accessors and focused setters through `AppPreferencesContext`.
- [x] Add migration and normalization tests.

## Phase 2: Pure audio settings policy

- [x] Add a browser-independent audio settings core module.
- [x] Resolve requested `AudioContextOptions`.
- [x] Build recording constraints from persisted intent and supported constraints.
- [x] Filter and deduplicate input/output devices.
- [x] Reconcile temporarily missing devices without clearing preferences.
- [x] Add focused unit tests.

## Phase 3: Configurable audio runtime

- [x] Let `createAudioRuntime` receive normalized runtime options.
- [x] Let `AudioEngine` retain options for its next runtime.
- [x] Add an accurate runtime snapshot.
- [x] Add safe live output sink application with feature detection.
- [x] Add a bounded output test tone.
- [x] Preserve synchronous initialization and active graph state.

## Phase 4: Global singleton bridge

- [x] Retain desired configuration independently of the singleton instance.
- [x] Construct new engines with the latest desired configuration.
- [x] Update future runtime settings on an existing engine without closing it.
- [x] Retain desired configuration across singleton reset.
- [x] Track sink status without polling.
- [x] Prevent stale async sink results from replacing newer status.
- [x] Synchronize persisted preferences from the application provider.

## Phase 5: Recording integration

- [x] Pass grouped recording preferences from `Timeline`.
- [x] Replace `getUserMedia({ audio: true })` with generated constraints.
- [x] Use exact device selection when a microphone is selected.
- [x] Include processing constraints only when supported.
- [x] Preserve every existing recording lock cleanup path.
- [x] Distinguish permission, missing-device, and generic capture failures.

## Phase 6: Device lifecycle

- [x] Enumerate devices on Audio page mount.
- [x] Refresh after permissions and manual requests.
- [x] Subscribe to `devicechange` and clean up on unmount.
- [x] Request microphone permission and stop the returned stream.
- [x] Invoke `selectAudioOutput()` from a direct user action.
- [x] Keep system default usable when output selection is unsupported.
- [x] Represent unavailable persisted devices clearly.

## Phase 7: Dashboard UI

- [x] Add the `audio` dashboard route and parser entry.
- [x] Add the Audio sidebar item and Settings menu shortcut.
- [x] Add Audio Devices, Audio Engine, Recording, and Diagnostics sections.
- [x] Use `DashboardSection`, `DashboardRow`, native selects, checkboxes, and buttons.
- [x] Do not create an audio context merely to display the page.
- [x] Show pending-next-context state for constructor-bound changes.
- [x] Explain browser-managed buffering instead of exposing a fake buffer control.

## Phase 8: Validation

- [x] Test preference migration and normalization.
- [x] Test recording constraints and device reconciliation.
- [x] Test runtime option resolution and singleton configuration retention.
- [x] Test stale sink result protection.
- [x] Test dashboard route parsing.
- [x] Run `bun test`.
- [x] Run `bun run typecheck`.
- [x] Run `bun run knip`.
- [x] Run `git diff --check`.
- [x] Run `bun run build`.

## Manual Chrome Smoke Matrix

- [ ] Open Audio Settings without a project and without creating an audio context.
- [ ] Grant and deny microphone access.
- [ ] Confirm device labels refresh after permission.
- [ ] Record with each available microphone.
- [ ] Verify browser processing through `MediaStreamTrack.getSettings()` where reported.
- [ ] Choose an output and play the test tone.
- [ ] Return to system output.
- [ ] Reload and verify restoration or a clear reauthorization state.
- [ ] Disconnect and reconnect selected devices.
- [ ] Change engine settings before context creation and verify actual values.
- [ ] Change engine settings while active and verify playback remains uninterrupted.
- [ ] Leave and reopen the timeline and verify the next context receives the new request.
- [ ] Verify unsupported and rejected output-selection paths.

## References

- Ableton Live 12 First Steps and Audio Settings.
- Ableton audio interface and latency guidance.
- MDN `AudioContext`, `setSinkId`, `selectAudioOutput`, `enumerateDevices`, and media constraints.
- Chrome Web Audio output-device routing guidance.
- Local dashboard patterns in `monorepo-new`.
- Settings row patterns in `opencode`.
- Solid device lifecycle patterns in `solid-primitives`.
