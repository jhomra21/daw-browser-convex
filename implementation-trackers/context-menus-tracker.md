# Context Menus Tracker

## Plan

- [x] 1. Create `context-menus` branch from clean `master`.
- [x] 2. Inspect current menu patterns, timeline targets, reference codebases, Kobalte docs, and Ableton context-menu references.
- [x] 3. Save useful Ableton reference images under `/private/tmp/ableton-ui-reference/context-menus/`.
- [x] 4. Add shared Kobalte context-menu primitives that match existing dropdown and menubar conventions.
- [x] 5. Add shared timeline context-menu renderer and typed command item model.
- [x] 6. Wire clip context menus to existing clip open, duplicate, delete, and missing-media actions.
- [x] 7. Wire track and master context menus to existing track, automation, routing, and mixer actions.
- [x] 8. Wire browser item context menus to existing asset insert and device add actions.
- [x] 9. Wire automation lane and point context menus to existing point commit and interpolation logic.
- [x] 10. Wire device and parameter context menus to existing effects and automation actions where supported.
- [x] 11. Add timeline-shell fallback context menu while preserving native menus for inputs and editable elements.
- [x] 12. Validate keyboard and accessibility behavior through Kobalte primitives and existing command handlers.
- [x] 13. Run validators: `bun run typecheck`, `bun test`, `bun run build`, `bun run knip`, and `git diff --check`.
- [x] 14. Run simplification pass and apply safe cleanup.
- [x] 15. Run reference-guided review against local reference codebases and apply grounded fixes.
- [x] 16. Rerun validators and final diff review.

## Reference Notes

- Current repo already uses Kobalte wrappers in `src/components/ui/dropdown-menu.tsx` and `src/components/ui/menubar.tsx`.
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/ui/context-menu.tsx` provides the closest Kobalte context-menu wrapper reference.
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/app-context-menu.tsx` shows app-shell wrapping, but this project should scope fallback menus to the timeline shell.
- `/Users/juan/Documents/dialkit/src/solid/components/ShortcutsMenu.tsx` shows compact action menu ergonomics, but custom absolute-positioned menus are not needed here because Kobalte covers right-click and keyboard behavior.
- Ableton references emphasize target-specific menus, grouped commands, shortcut labels, checked state, and submenus.

## Risks

- Do not duplicate command behavior. Context menus should call existing handlers.
- Do not break native browser context menus in inputs, textareas, selects, or editable elements.
- Do not introduce custom menu positioning unless Kobalte cannot support a target.
- Keep the feature split by surface so each action remains owned by the existing controller or component.
