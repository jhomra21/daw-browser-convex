# Ableton Live UI Reference

Screenshots from the official Ableton Live 12 manual (https://www.ableton.com/en/live-manual/12/). Each image is the manual's own 1440px-wide variant (`?auto=&w=1440`).

Reference only, from the Ableton Live manual; do not ship these images in the app.

Use these images for layout and interaction patterns only. Do not copy Ableton's colors, fonts or visual styling; keep the app's existing theme and styling.

Only `midi-note-editor-layout.png`, `midi-velocity-marker.png`, and `control-bar.png` were checked by eye. The other descriptions come from the manual's section titles and filenames, so confirm each one against its image before relying on it.

| Image file | Source manual page | Matching app surface | What it shows |
| --- | --- | --- | --- |
| `midi-note-editor-layout.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Full MIDI Note Editor: rulers, note grid, Notes/Envelopes/MPE tabs, and the velocity lane under the grid (numbered callouts). |
| `midi-note-editor-rulers.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Bar/beat ruler and keyboard ruler of the note editor. |
| `midi-velocity-lane-controls.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Velocity lane control strip: Velocity, Randomize, Ramp, Deviation fields. |
| `midi-velocity-marker.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Velocity lane with one dot per note, a selected range box, and the Ramp/Deviation fields. |
| `midi-velocity-ramp-sliders.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Ramp sliders that shape velocity across the selection. |
| `midi-velocity-deviation.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Deviation slider for random velocity spread. |
| `midi-velocity-randomization.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Randomization amount for velocities. |
| `midi-drawing-velocities.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Drawing velocities by dragging in the velocity lane. |
| `midi-release-velocity-editor.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Note-off (release) velocity lane. |
| `midi-note-length.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Note length editing with note end handles and Fit to Time Range. |
| `midi-clip-loop-region.png` | https://www.ableton.com/en/live-manual/12/editing-midi/ | `src/components/midi/MidiEditorCard.tsx` | Clip loop region shown over the note grid. |
| `clip-view-layout.png` | https://www.ableton.com/en/live-manual/12/clip-view/ | `src/components/timeline/SampleDetailPanel.tsx` | Clip View layout: title bar, clip/device selector, and panels. |
| `clip-view-midi-clip.png` | https://www.ableton.com/en/live-manual/12/clip-view/ | `src/components/midi/MidiEditorCard.tsx` | MIDI clip view: note editor with clip properties. |
| `clip-view-audio-clip.png` | https://www.ableton.com/en/live-manual/12/clip-view/ | `src/components/timeline/SampleDetailPanel.tsx` | Audio clip view: sample waveform with clip properties and warp controls. |
| `clip-view-main-properties.png` | https://www.ableton.com/en/live-manual/12/clip-view/ | `src/components/timeline/SampleClipPanel.tsx` | Main clip properties panel: start/end, loop, time signature, groove, and scale. |
| `clip-view-warp-controls.png` | https://www.ableton.com/en/live-manual/12/clip-view/ | `src/components/timeline/SampleClipPanel.tsx` | Warp controls: warp toggle and warp mode selector. |
| `sample-editor-warp-markers.png` | https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/ | `src/components/timeline/SampleDetailWaveform.tsx` | Warp markers on the waveform, each tied to a beat position. |
| `sample-editor-transient-markers.png` | https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/ | `src/components/timeline/SampleDetailWaveform.tsx` | Transient markers on the waveform. |
| `sample-editor-auto-warp.png` | https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/ | `src/components/timeline/SampleDetailWaveform.tsx` | Auto-warped clip with the generated warp markers. |
| `arrangement-view-layout.png` | https://www.ableton.com/en/live-manual/12/arrangement-view/ | `src/components/timeline/timeline-workspace.tsx` | Arrangement View: tracks, clips, ruler, loop, and mixer. |
| `arrangement-position-fields.png` | https://www.ableton.com/en/live-manual/12/arrangement-view/ | `src/components/timeline/TransportControls.tsx` | Arrangement position fields for the playhead, in bars.beats.sixteenths. |
| `arrangement-locators.png` | https://www.ableton.com/en/live-manual/12/arrangement-view/ | `src/components/timeline/TimelineRuler.tsx` | Locators on the arrangement ruler. |
| `arrangement-loop-brace.png` | https://www.ableton.com/en/live-manual/12/arrangement-view/ | `src/components/timeline/TimelineRuler.tsx` | Arrangement loop brace over the ruler. |
| `arrangement-automation-lane.png` | https://www.ableton.com/en/live-manual/12/automation/ | `src/components/timeline/automation-lane.tsx` | Automation lane under a track with the parameter chooser. |
| `automation-envelope.png` | https://www.ableton.com/en/live-manual/12/automation/ | `src/components/timeline/automation-lane.tsx` | Automation envelope with breakpoints and segments. |
| `automation-multiple-lanes.png` | https://www.ableton.com/en/live-manual/12/automation/ | `src/components/timeline/automation-lane.tsx` | Several automation lanes stacked under one track. |
| `control-bar.png` | https://www.ableton.com/en/live-manual/12/live-concepts/ | `src/components/timeline/TransportControls.tsx` | Full Live window with the Control Bar across the top (Link, tempo, time signature, position, record, and loop controls). |
| `control-bar-loop-controls.png` | https://www.ableton.com/en/live-manual/12/arrangement-view/ | `src/components/timeline/TransportControls.tsx` | Control Bar loop controls: loop start, length, and loop toggle. |
| `mixer-arrangement-view.png` | https://www.ableton.com/en/live-manual/12/mixing/ | `src/components/timeline/TrackSidebar.tsx` | Mixer strips in Arrangement View under the track headers. |
| `track-headers.png` | https://www.ableton.com/en/live-manual/12/mixing/ | `src/components/timeline/TrackSidebarRow.tsx` | Track headers with numbered callouts. |
| `mixer-sends.png` | https://www.ableton.com/en/live-manual/12/mixing/ | `src/components/timeline/TrackSidebarRow.tsx` | Send controls in the mixer. |
| `device-view.png` | https://www.ableton.com/en/live-manual/12/live-concepts/ | `src/components/timeline/EffectsPanel.tsx` | Device View under the clip view, showing the device chain. |
| `device-chain-rack-chain-list.png` | https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/ | `src/components/timeline/EffectsPanel.tsx` | Rack chain list beside the rack devices. |
| `drum-rack-pad-view.png` | https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/ | `src/components/effects/DrumRack.tsx` | Drum Rack Pad View: the pad grid with chain selection. |
| `eq-eight-main.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Eq.tsx` | EQ Eight main view: frequency graph with band points and Freq/Gain/Q controls. |
| `eq-eight-expanded.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Eq.tsx` | EQ Eight expanded view with the per-band controls. |
| `reverb-main.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb main view with its main controls. |
| `reverb-input-filter.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb input filter section. |
| `reverb-early-reflections.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb early reflections section. |
| `reverb-diffusion-network.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb diffusion network section. |
| `reverb-chorus.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb chorus section. |
| `reverb-global-settings.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb global settings section. |
| `reverb-output.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Reverb.tsx` | Reverb output section. |
| `delay.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Delay.tsx` | Delay device with its delay and filter sections. |
| `auto-filter.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/AutoFilter.tsx` | Auto Filter device with the filter display and LFO controls. |
| `phaser-flanger.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Phaser.tsx`, `src/components/effects/Flanger.tsx` | Phaser-Flanger device, the shared device for both effects. |
| `gate.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Gate.tsx` | Gate device with threshold and envelope controls. |
| `compressor-main.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Compressor.tsx` | Compressor device with its threshold, ratio, and envelope controls. |
| `compressor-transfer-curve.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Compressor.tsx` | Compressor transfer curve display. |
| `compressor-sidechain.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Compressor.tsx` | Compressor sidechain parameters. |
| `compressor-output.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Compressor.tsx` | Compressor output section. |
| `utility.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Utility.tsx` | Utility device with Gain, Pan, Balance, and Width controls. |
| `limiter.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Limiter.tsx` | Limiter device with Ceiling, Release, and gain reduction. |
| `saturator.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Saturator.tsx` | Saturator device with the color curve and Drive/Output controls. |
| `auto-pan-tremolo.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/AutoPan.tsx`, `src/components/effects/Tremolo.tsx` | Auto Pan-Tremolo device with its panning and tremolo modes. |
| `chorus-ensemble.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Chorus.tsx`, `src/components/effects/Ensemble.tsx` | Chorus-Ensemble device with modulation and global controls. |
| `arpeggiator.png` | https://www.ableton.com/en/live-manual/12/live-midi-effect-reference/ | `src/components/effects/Arpeggiator.tsx` | Arpeggiator MIDI effect with its rate and gate controls. |
| `analog.png` | https://www.ableton.com/en/live-manual/12/live-instrument-reference/ | `src/components/effects/Synth.tsx` | Analog synth closest match: oscillators, filter, and envelope sections. |
| `sampler.png` | https://www.ableton.com/en/live-manual/12/live-instrument-reference/ | `src/components/effects/Sampler.tsx` | Sampler with its zone editor and tabs. |
| `simpler.png` | https://www.ableton.com/en/live-manual/12/live-instrument-reference/ | `src/components/effects/Sampler.tsx` | Simpler, the closest match for the app's sampler (no Simpler component exists in the app). |
| `redux.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/LoFi.tsx` | Redux, the closest match for LoFi: bit depth and sample rate reduction. |
| `grain-delay.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Granular.tsx` | Grain Delay, the closest match for Granular: grain size and pitch controls. |
| `spectral-time.png` | https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/ | `src/components/effects/Spectral.tsx` | Spectral Time: freezer, delay, and resolution sections. |
| `browser-layout.png` | https://www.ableton.com/en/live-manual/12/working-with-the-browser/ | `src/components/timeline/browser/timeline-left-browser.tsx` | Browser layout: categories, search, content pane, and preview. |
| `export-render-selection.png` | https://www.ableton.com/en/live-manual/12/managing-files-and-sets/ | `src/components/timeline/ExportDialog.tsx` | Export/render dialog: selection options. |
| `export-rendering-options.png` | https://www.ableton.com/en/live-manual/12/managing-files-and-sets/ | `src/components/timeline/ExportDialog.tsx` | Export/render dialog: rendering options. |
| `export-encoding-options.png` | https://www.ableton.com/en/live-manual/12/managing-files-and-sets/ | `src/components/timeline/ExportDialog.tsx` | Export/render dialog: encoding options. |
| `preferences-audio.png` | https://www.ableton.com/en/live-manual/12/first-steps/ | `src/components/dashboard/audio-view.tsx` | Live's Settings, Audio section (manual section 2.3.3). The Live preferences URL returned 404, so this is from First Steps. |
| `context-menu-device-title-bar.png` | https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/ | `src/components/effects/EffectShell.tsx` | Device title bar context menu options (AutoFilter example). |
| `context-menu-rack-navigation.png` | https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/ | `src/components/ui/context-menu.tsx` | Rack navigation context menu. |
