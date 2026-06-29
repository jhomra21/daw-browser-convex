# MIDI UX Improvements Tracker

## Plan

- [ ] 1. Create `midi-ux-improvements` branch, add this tracker, commit, and push.
- [ ] 2. Hoist MIDI keyboard ownership from `MidiEditorCard` into the timeline MIDI overlay.
- [ ] 3. Make global MIDI routing explicit: editor clip track, selected instrument FX target, selected instrument track, otherwise no target.
- [ ] 4. Add a compact top-right MIDI Keys transport toggle near save status.
- [ ] 5. Improve keyboard behavior: modifier guard, Z/X octave, C/V velocity, shared octave/velocity accessors, and deterministic note stop on disable, target loss, project change, blur, and cleanup.
- [ ] 6. Make the MIDI editor consume shared active notes for piano gutter highlighting.
- [ ] 7. Reduce MIDI editor modal blocking while preserving editor event isolation.
- [ ] 8. Verify MIDI clip creation selects the clip, moves playhead, opens the editor, and routes MIDI Keys to the clip track; fix only if incomplete.
- [ ] 9. Apply focused editor note editing polish without a broad piano-roll rewrite.
- [ ] 10. Add or update focused tests for pure MIDI logic where supported.
- [ ] 11. Run validators: `bun run typecheck`, `bun test`, `bun run knip`, `bun run build`.
- [ ] 12. Simplification pass, rerun validators, update tracker, commit, and push final state.
