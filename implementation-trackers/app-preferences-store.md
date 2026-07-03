# App Preferences Store Implementation Tracker

## Goal

Centralize browser-scoped app/user preferences in a versioned persisted Solid store while keeping project-scoped DAW state in its existing project storage.

## Plan Validation

- Confirmed existing theme settings were split across `src/lib/app-settings-storage.ts`, `src/hooks/useAppSettings.ts`, and `src/components/dashboard/general-view.tsx`.
- Confirmed AgentChat stored auto-apply directly in `localStorage` using `agent_auto_apply`.
- Confirmed sidebar uncontrolled open state was stored directly in the `sidebar:state` cookie.
- Confirmed no legacy user preference data needs migration, so the new preference store starts from fresh defaults when the versioned preferences key is absent.
- Confirmed timeline, bottom panel, MIDI, automation, BPM, loop, grid, mix, and history persistence are project or workflow scoped and should not move into global app preferences in this pass.
- Confirmed `@solid-primitives/storage` was not present and must be added.

## Implementation Steps

1. Add `@solid-primitives/storage`.
2. Add `src/lib/preferences/app-preferences-core.ts` and `src/lib/preferences/app-preferences.ts` with:
   - versioned defaults
   - unknown-data normalization
   - synchronous initial preference loading for Kobalte boot
   - persisted store creation with `createStore` and `makePersisted`
3. Add `src/context/app-preferences.tsx` with provider, hook, and consumer-shaped actions.
4. Update app bootstrap provider order while preserving synchronous Kobalte initial color mode.
5. Update dashboard theme settings to use the preferences context.
6. Update AgentChat auto-apply to use centralized preferences.
7. Update sidebar uncontrolled open state to use centralized preferences and remove cookie writes.
8. Add focused tests for normalization helpers.
9. Run validators: `bun run typecheck`, `bun test`, and `git diff --check`.
10. Review final diff for regressions, contract drift, dead code, duplicate logic, and consistency.
11. Run simplify pass and remove unused compatibility shims after call sites migrate.
12. Run reference-guided review against OpenCode settings/layout, Solid Primitives storage, and Monorepo New layout patterns.
13. Apply reference-guided cleanup:
   - remove unused keymap preference surface until a real consumer exists
   - expose domain-grouped context APIs instead of a raw preferences store
   - use a localStorage sync adapter that is not route URL scoped
   - fall back to an in-memory store when localStorage is unavailable
   - simplify uncontrolled sidebar initialization from persisted app preferences
14. Run thermo review and apply reliability/API cleanups:
   - reject unknown preference versions instead of trusting incompatible blobs
   - rename and explain the same-origin localStorage sync adapter
   - add a consumer-shaped `agent.toggleAutoApply()` action
15. Run defensive-code review and remove redundant API/guard surface:
   - remove unused `agent.setAutoApply()` context action
   - simplify sidebar controlled-callback and default-open checks

## Risks Avoided

- Do not migrate project-scoped DAW state into app preferences.
- Do not break synchronous Kobalte initial color mode.
- Do not duplicate preference persistence at call sites.
- Do not discard existing user changes in `AGENTS.md`.
- Do not keep unused preference API surface before consumers exist.
- Do not partially trust future/unknown persisted preference versions.
- Do not keep redundant optional calls after a callback is already proven present.
