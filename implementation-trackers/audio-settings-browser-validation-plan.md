# Audio Settings Browser Validation Plan

## Purpose

Validate the merged Audio Settings dashboard as a user would experience it in the in-app browser. Confirm that the page is usable, every interactive control produces the expected visible or audible result, preferences persist, browser limitations are explained accurately, and no interaction breaks timeline audio.

This is a validation-only task. Do not modify code, create commits, fix defects, or change application data beyond the preferences needed for these tests.

## Scope

Validate:

- Dashboard navigation to Audio Settings.
- Audio input enumeration and microphone permission.
- Authorized playback-output selection.
- System-output restoration.
- Requested sample rate and latency-mode preferences.
- Pending-next-context behavior.
- Echo cancellation, noise suppression, and automatic gain control controls.
- Runtime diagnostics.
- Output test tone.
- Preference persistence.
- Error, cancellation, unsupported-feature, and unavailable-device UX.
- Interaction with timeline playback and recording.

Do not evaluate:

- Native driver selection.
- Hardware buffer-size control.
- Interface control panels.
- Hardware channel matrices.
- Exact round-trip latency.
- Production DSP quality.
- Features outside Audio Settings except where needed to verify playback or recording integration.

## Tester Rules

1. Use the application only through the in-app browser and normal user interactions.
2. Do not edit source files, run formatters, install dependencies, create commits, or attempt fixes.
3. Do not use direct store or DOM mutation to force a result.
4. Browser developer tools may be used only to inspect console errors, network failures, local storage, media-device state, and active media-track settings.
5. Never mark a test as passing solely because a control exists. Trigger it and verify the resulting state or behavior.
6. Take a screenshot for every failure and for each major page state.
7. Record console errors associated with a failed interaction.
8. If the environment lacks a microphone, multiple outputs, permission control, or audible playback, mark the affected test `BLOCKED`, not `PASS`.
9. Do not infer audible success from the absence of an exception.
10. Restore changed preferences to their original values at the end when practical.

## Result States

- `PASS`: The interaction was performed and its expected effect was directly verified.
- `FAIL`: The interaction was performed and produced incorrect, broken, misleading, or missing behavior.
- `BLOCKED`: The browser, machine, permissions, hardware, or test environment prevented direct verification.
- `NOT RUN`: The test was not attempted.

## Preconditions

- [ ] Application loads successfully in the in-app browser.
- [ ] Tester can access the dashboard and a project timeline.
- [ ] Browser console is clear of pre-existing fatal errors.
- [ ] Current browser name and version are recorded.
- [ ] Available microphones and outputs are recorded.
- [ ] Initial microphone permission state is recorded.
- [ ] Initial Audio Settings preference values are recorded.
- [ ] Initial engine state and diagnostics are recorded.
- [ ] At least one project contains audible material for playback testing.
- [ ] A microphone is available for recording tests, or those tests are marked `BLOCKED`.

## Test 1: Navigation and Initial Page State

### Steps

1. Load the dashboard without first starting timeline playback.
2. Confirm an `Audio` item appears in the dashboard navigation.
3. Open Audio Settings from the dashboard navigation.
4. Return to the timeline.
5. Open Audio Settings from the Settings menu shortcut.
6. Inspect the complete page at normal desktop width.

### Expected

- [ ] Both navigation paths open the same Audio Settings page.
- [ ] The page shows Audio Devices, Audio Engine, Recording, and Diagnostics sections.
- [ ] Labels and controls are readable, aligned, and not clipped or overlapping.
- [ ] Keyboard focus is visible on buttons, selects, and checkboxes.
- [ ] Opening the page alone does not start playback or produce sound.
- [ ] Before an audio context exists, engine state is `uninitialized`.
- [ ] Actual sample rate says `No audio context`.
- [ ] Unavailable latency values say `Unavailable`.
- [ ] Buffer size is presented as browser-managed information, not an editable control.
- [ ] No new console error appears.

## Test 2: Microphone Permission and Device Refresh

Run this test once with permission denied and once with permission granted when the browser environment permits resetting permission.

### Denied path

1. Set microphone permission to ask or denied.
2. Click `Request access`.
3. Deny the browser prompt.

### Expected

- [ ] The page remains usable.
- [ ] A clear microphone-permission error is shown.
- [ ] No recording or audio context is left running.
- [ ] Repeated clicks do not duplicate or stack stale errors.

### Granted path

1. Reset microphone permission to ask.
2. Click `Request access`.
3. Grant access.
4. Wait for device enumeration to refresh.
5. Open the Recording input select.

### Expected

- [ ] Device labels refresh after permission is granted.
- [ ] Available microphones appear once each.
- [ ] `System default` remains available.
- [ ] The permission-probe stream stops after enumeration.
- [ ] No recording indicator remains active after the request completes.
- [ ] No new console error appears.

## Test 3: Recording Input Selection and Persistence

1. Select a specific microphone.
2. Navigate away from Audio Settings and return.
3. Reload the application and return to Audio Settings.
4. Select `System default`.
5. Reload again.

### Expected

- [ ] The selected microphone remains selected after navigation.
- [ ] The selected microphone remains selected after reload.
- [ ] Selecting `System default` clears the specific-device choice.
- [ ] `System default` remains selected after reload.
- [ ] Device-list refresh does not unexpectedly change the saved selection.

If the environment permits disconnecting or disabling a selected microphone:

1. Select the microphone.
2. Disconnect or disable it.
3. Trigger or wait for a device refresh.

### Expected

- [ ] The UI reports that the saved device is currently unavailable.
- [ ] The saved preference is not silently replaced.
- [ ] Reconnecting the device restores its availability without requiring a new selection when the browser preserves its device ID.

## Test 4: Recording Processing Controls

For each of Echo cancellation, Noise suppression, and Automatic gain control:

1. Record the initial value.
2. Toggle the checkbox.
3. Navigate away and return.
4. Reload the application.
5. Toggle it back.

### Expected

- [ ] A supported control is enabled and changes immediately.
- [ ] The changed value survives navigation and reload.
- [ ] An unsupported control is disabled.
- [ ] An unsupported control displays `Not supported by this browser`.
- [ ] No control appears enabled while doing nothing.

When media-track inspection is available, start a short recording and inspect `MediaStreamTrack.getSettings()`:

- [ ] Report whether each supported setting matches the requested value.
- [ ] Treat a browser-ignored constraint as a browser limitation and include the observed requested and active values.

## Test 5: Recording Integration

Repeat with `System default` and each available specific microphone.

1. Select the recording input.
2. Set the three processing controls to known values.
3. Open a project timeline.
4. Arm a track and start recording through the normal UI.
5. Produce a short audible input.
6. Stop recording.
7. Play the recorded clip.

### Expected

- [ ] Recording starts with the selected input.
- [ ] Recording stop and cleanup complete normally.
- [ ] A recorded clip is created.
- [ ] The clip contains the expected microphone signal.
- [ ] Playback of the new clip works.
- [ ] Permission denial produces a clear error rather than a silent failure.
- [ ] A missing selected device produces a specific missing-device error.
- [ ] Recording locks and controls return to their normal state after every success or failure.
- [ ] No lingering microphone capture remains after recording stops.

## Test 6: Sample Rate Before Context Creation

Perform this with the engine showing `uninitialized`.

For System default, 44.1 kHz, 48 kHz, and 96 kHz:

1. Select the requested sample rate.
2. Confirm the selected value remains visible after leaving and reopening Audio Settings.
3. Start timeline playback or play the output test tone to create the context.
4. Return to Audio Settings and record the actual sample rate.

### Expected

- [ ] Each preference selection is accepted and persists.
- [ ] The context is created successfully.
- [ ] Actual sample rate reports the browser's real active rate.
- [ ] When the browser honors the request, actual and requested rates agree.
- [ ] When the browser rejects a requested rate, audio still initializes using a supported default.
- [ ] A fallback is observable as a requested/actual mismatch, not a playback failure.
- [ ] No unsupported request traps the application in repeated initialization errors.

Close or leave the timeline through the normal application flow before testing the next constructor-bound value.

## Test 7: Latency Mode Before Context Creation

Perform this with the engine showing `uninitialized`.

For Interactive, Balanced, and Playback:

1. Select the latency mode.
2. Navigate away and return.
3. Reload and confirm persistence.
4. Create the audio context through normal playback.
5. Inspect diagnostics.

### Expected

- [ ] The preference persists.
- [ ] Audio initializes successfully in every mode.
- [ ] Engine diagnostics become populated where the browser reports values.
- [ ] Missing browser latency data remains `Unavailable`, not zero or fabricated.
- [ ] Total output estimate equals base latency plus output latency when both are available.

## Test 8: Changes While the Engine Is Active

1. Start timeline playback.
2. Open Audio Settings while playback is active.
3. Change requested sample rate.
4. Change latency mode.
5. Observe playback and the page.

### Expected

- [ ] Playback continues without interruption, restart, click, or graph loss.
- [ ] The existing context is not rebuilt.
- [ ] Actual sample rate does not falsely change on the active context.
- [ ] A pending-next-context message appears.
- [ ] Returning the controls to the active values removes the pending message.
- [ ] The requested values persist.

Then:

1. Stop playback.
2. Leave the timeline so its audio lifecycle closes normally.
3. Reopen the timeline and start playback.
4. Return to Audio Settings.

### Expected

- [ ] The newly created context uses the latest requested settings where supported.
- [ ] The pending message disappears.
- [ ] Timeline playback and project state remain intact.

## Test 9: Playback Output Selection

### System output

1. Click `System output`.
2. Start timeline playback.
3. Play the output test tone.

### Expected

- [ ] Route status settles to `applied` when live sink routing is supported.
- [ ] Timeline audio uses the system output.
- [ ] The test tone is audible through the system output.
- [ ] No stale pending state remains.

### Authorized output

If the browser exposes output selection:

1. Click `Choose output`.
2. Select a non-default output.
3. Observe route status.
4. Play the output test tone.
5. Start timeline playback.

### Expected

- [ ] The browser output chooser opens only after the button click.
- [ ] The chosen output is saved.
- [ ] Route status progresses through pending to applied.
- [ ] The tone is audible through the chosen output.
- [ ] Timeline audio uses the chosen output.
- [ ] Changing the output refreshes latency diagnostics where the browser reports changed values.
- [ ] One click does not produce duplicate prompts, tones, or visible route transitions.

### Cancelled selection

1. Click `Choose output`.
2. Cancel the browser chooser.

### Expected

- [ ] The current output remains unchanged.
- [ ] A clear cancellation or browser error is shown.
- [ ] The rest of the page remains usable.

### Unsupported browser

If output selection is unavailable:

- [ ] Clicking `Choose output` shows the unsupported message.
- [ ] `System output` and normal playback remain usable.
- [ ] The UI does not claim that a non-default output was applied.

## Test 10: Output Test Tone Isolation

1. Confirm the project master is audible and play the tone.
2. Mute or reduce the project master volume to silence.
3. Play the tone again.
4. If master effects are available, configure an obvious master effect and play the tone again.

### Expected

- [ ] Each click produces one short 440 Hz tone.
- [ ] The tone ends automatically after roughly 0.35 seconds.
- [ ] The tone remains audible when project master volume is muted.
- [ ] The tone bypasses project master effects.
- [ ] The tone follows the currently applied output route.
- [ ] Rapid clicks do not create a stuck oscillator or continuous sound.
- [ ] No oscillator, gain node, or error remains after the tone ends.

## Test 11: Output Persistence and Reauthorization

1. Select a non-default output.
2. Reload the application.
3. Return to Audio Settings before starting timeline audio.
4. Record the route message.
5. Start audio and play the tone.

### Expected

- [ ] The saved output intent persists.
- [ ] Before context creation, the UI clearly says the output will apply when audio starts when applicable.
- [ ] After context creation, the output is applied if browser authorization remains valid.
- [ ] If reauthorization is required, the UI reports this clearly and does not silently claim success.
- [ ] Returning to `System output` persists after reload.

If the selected output can be disconnected:

- [ ] The page reports that the saved output requires reconnection or reauthorization.
- [ ] The preference is retained.
- [ ] The route can recover after reconnection or explicit reselection.

## Test 12: Diagnostics Reactivity

1. Open Audio Settings before context creation.
2. Create the context with the output test tone.
3. Suspend and resume audio through normal application actions if available.
4. Change output.
5. Close the timeline audio lifecycle.

### Expected

- [ ] Engine state updates without page reload.
- [ ] Actual sample rate appears after initialization.
- [ ] Base, output, and total latency update when the browser changes them.
- [ ] Output changes do not leave stale latency values.
- [ ] Closing the audio lifecycle returns diagnostics to the uninitialized state when the dashboard obtains the next engine instance.
- [ ] Diagnostic values do not flicker repeatedly between identical states.
- [ ] No console error reports leaked or closed AudioContext usage.

## Test 13: Rapid Interaction and Stale Result Protection

1. Trigger device refresh by granting permission or causing a device change.
2. Navigate away immediately and return.
3. Quickly switch output intent between a chosen output and system output when supported.
4. Immediately click `Play tone`.
5. Repeat the sequence several times without excessive automation.

### Expected

- [ ] An older device-enumeration result never replaces a newer list.
- [ ] The final route status corresponds to the final selected output.
- [ ] A stale output request never overwrites a newer result.
- [ ] The test tone waits for the final selected output to apply.
- [ ] No duplicate output-routing operation causes a false error.
- [ ] No state update or console error occurs after the Audio page unmounts.

## Test 14: Persistence Regression Check

1. Change one appearance preference and record its value.
2. Change one sidebar or timeline preference and record its value.
3. Change several Audio Settings values.
4. Reload the application.

### Expected

- [ ] Audio preferences persist.
- [ ] Existing non-audio preferences retain their values.
- [ ] No preference group resets because of the version 1 to version 2 migration.
- [ ] No malformed or blank Audio Settings control appears.

## Test 15: General UX and Accessibility

- [ ] All controls have understandable visible labels.
- [ ] Buttons communicate their action before activation.
- [ ] Disabled controls explain why they are disabled.
- [ ] Errors appear near the relevant Audio Settings content.
- [ ] Errors clear after a subsequent successful action.
- [ ] Saved-but-unavailable devices are distinguished from system default.
- [ ] Pending settings are distinguished from active runtime values.
- [ ] The page does not imply access to native drivers or hardware buffer controls.
- [ ] Tab order follows the visual order.
- [ ] Selects, checkboxes, and buttons work with keyboard input.
- [ ] Focus is not lost after permission or output dialogs close.
- [ ] Text remains readable at 200% browser zoom.

## Required Evidence

Capture:

- [ ] Initial uninitialized page.
- [ ] Permission denied result.
- [ ] Permission granted device list.
- [ ] Saved specific input.
- [ ] Unsupported processing control, if any.
- [ ] Active engine diagnostics.
- [ ] Pending-next-context message.
- [ ] Applied output route.
- [ ] Cancelled or unsupported output-selection result.
- [ ] Saved unavailable device state, if testable.
- [ ] Every failure or blocked browser dialog.
- [ ] Relevant console errors.

For audible checks, explicitly state:

- Which physical or virtual output was monitored.
- Whether the tone or timeline audio was directly heard.
- Whether master mute/effects changed the test tone.
- Whether recorded microphone audio was directly heard on playback.

## Codex Response Contract

Return one report using this exact structure:

```md
# Audio Settings Browser Validation Report

## Environment
- App URL:
- Commit:
- Browser/version:
- Operating system:
- Available inputs:
- Available outputs:
- Initial microphone permission:
- Output-selection API available: Yes/No
- Audible playback available: Yes/No

## Summary
- PASS:
- FAIL:
- BLOCKED:
- NOT RUN:
- Overall verdict: PASS / PASS WITH BLOCKED COVERAGE / FAIL

## Results
| Test | State | Evidence | Notes |
|---|---|---|---|
| 1. Navigation and initial state | PASS/FAIL/BLOCKED/NOT RUN | screenshot or observation | |
| 2. Microphone permission | | | |
| 3. Input selection and persistence | | | |
| 4. Recording processing controls | | | |
| 5. Recording integration | | | |
| 6. Sample rate before initialization | | | |
| 7. Latency mode before initialization | | | |
| 8. Active-engine changes | | | |
| 9. Output selection | | | |
| 10. Test-tone isolation | | | |
| 11. Output persistence | | | |
| 12. Diagnostics reactivity | | | |
| 13. Rapid interaction and stale results | | | |
| 14. Preference regression | | | |
| 15. UX and accessibility | | | |

## Failures
### Failure 1
- Test:
- Severity: Blocking / High / Medium / Low
- Steps to reproduce:
- Expected:
- Actual:
- Screenshot:
- Console error:
- Reproduction rate:
- Suspected area, if directly evidenced:

## Blocked Coverage
- Test:
- Blocking limitation:
- What was still verified:
- What requires manual hardware/browser testing:

## Console and Runtime Observations
- New console errors:
- Permission behavior:
- Requested versus actual sample rate:
- Active media-track settings:
- Base latency:
- Output latency:
- Total output estimate:

## Final Recommendation
- Safe to continue: Yes/No
- Required fixes before continuing:
- Manual follow-up still required:
```

## Verdict Rules

- Overall `PASS` requires every applicable test to pass and no material blocked coverage.
- `PASS WITH BLOCKED COVERAGE` is allowed only when every performed test passes and blocked items are caused solely by unavailable browser APIs, permissions, hardware, or inaudible remote execution.
- Overall `FAIL` is required for any broken control, false success state, stale result, lost preference, interrupted playback, recording failure, uncaught console error, misleading diagnostics, or interaction that visibly does nothing when it claims success.
- Do not recommend or implement fixes. Report observed evidence only.
