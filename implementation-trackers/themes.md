# Themes Implementation Tracker

## Named Themes Plan

### Goal

Add named theme support while keeping app preferences as the only persistence source and preserving the existing `system | light | dark` color scheme behavior.

### Acceptance Criteria

- Persist `appearance.themeId` with fallback to `default`; missing or invalid ids normalize without dropping other valid v1 preferences.
- Keep `appearance.theme`, `appearance.resolvedTheme()`, and `appearance.setTheme()` working.
- Add built-in `default`, `catppuccin`, and `tokyonight` themes using a compact OpenCode-compatible palette shape.
- Resolve named themes into concrete CSS variable values and apply them through one `#daw-theme` style element.
- Support temporary preview for named theme and color scheme, commit on selection, and cancel on leave/blur/Escape without persistence.
- Redraw canvas/SVG theme consumers when either color scheme or theme id changes.
- Cover preference fallback and resolver behavior with tests.
- Pass `bun run typecheck`, `bun test`, `git diff --check`, and `bun run build`.

### Implementation Steps

1. Extend app preferences with `appearance.themeId` and parse unknown ids to `default`.
2. Add theme types, registry, resolver, and DOM application helper.
3. Extend the app preferences context with active theme id, options, preview, commit, and cancel APIs.
4. Replace dashboard settings with separate color scheme and named theme controls.
5. Add redraw dependencies where canvas/SVG reads CSS variables.
6. Add tests for normalization, registry fallback, resolver output, overrides, and CSS generation.
7. Run validators, review the final diff, and commit if clean.

## Goal

Complete theme support for `system | light | dark` using app preferences as the single persistence source, Kobalte for document color mode, Tailwind v4/CSS semantic tokens for UI, and a small resolved theme API for JS, canvas, and SVG code.

## Acceptance Criteria

- `appearance.theme()` returns the stored user selection: `system | light | dark`.
- `appearance.setTheme(theme)` persists through existing app preferences storage only.
- `appearance.resolvedTheme()` returns `light | dark` and follows `prefers-color-scheme` when stored theme is `system`.
- Theme select change parsing uses a helper and no typecasts.
- No new `localStorage` key or parallel Kobalte-only persistence is introduced.
- Base CSS variables are valid full CSS colors, not `hsl(var(--...))` wrapping `oklch(...)`.
- Sidebar tokens use the active `--sidebar` family, without stale `--sidebar-background` duplication.
- Existing semantic tokens and DAW-specific tokens are mapped through Tailwind v4 `@theme inline`.
- Dashboard and prioritized DAW workspace components use semantic token utilities instead of hardcoded dark neutral foundation classes where feasible.
- Canvas/SVG literal colors in priority files read CSS variables where useful and remain deterministic.
- Tests cover theme preference parsing, resolved theme logic, and select parsing.
- `bun run typecheck`, `bun test`, and `git diff --check` pass.

## Phase 1: Validate Current Architecture

Read and confirm behavior in:

- `src/lib/preferences/app-preferences-core.ts`
- `src/lib/preferences/app-preferences.ts`
- `src/context/app-preferences.tsx`
- `src/main.tsx`
- `src/index.css`
- `tailwind.config.cjs`
- dashboard components under `src/components/dashboard/`
- timeline and effects priority files under `src/components/timeline/` and `src/components/effects/`

Validation findings to preserve:

- Stored app preference shape is `appearance.theme: "system" | "light" | "dark"`.
- App preferences already hydrate before `ColorModeProvider` and drive Kobalte `setColorMode`.
- Kobalte is used for document theme attributes, but app preferences remain source of truth.
- A local helper is required for resolved theme because JS/canvas code needs `light | dark`.

## Phase 2: Theme API and Helpers

Files:

- `src/lib/preferences/app-preferences-core.ts`
- `src/context/app-preferences.tsx`
- add `src/lib/theme/resolved-theme.ts` if no equivalent exists
- update tests under existing test locations

Work:

- Keep `AppTheme` compatible with Kobalte `ConfigColorMode`.
- Keep `parseAppTheme(value)` fallback behavior.
- Add a `parseAppThemeSelectValue(value: string): AppTheme | null` helper for DOM select changes.
- Add pure `resolveAppTheme(theme, prefersDark)` helper returning `light | dark`.
- Add provider API `appearance.resolvedTheme(): "light" | "dark"`.
- Use Solid Primitives media query or equivalent existing dependency to update resolved theme when system preference changes.

Risks:

- Do not add a second persistence source.
- Do not change stored schema unless a migration is proven necessary.
- Do not typecast select values.

## Phase 3: CSS and Tailwind Token Foundation

Files:

- `src/index.css`
- `tailwind.config.cjs`

Work:

- Remove conflicting HSL-wrapped color extensions from `tailwind.config.cjs` when covered by Tailwind v4 `@theme inline`.
- Ensure base styles use `var(--background)`, `var(--foreground)`, `var(--border)`, not `hsl(var(--...))`.
- Remove stale `--sidebar-background` token family unless a real consumer exists.
- Add `--info`, `--success`, `--warning`, `--error` and foreground tokens in light/dark.
- Add DAW semantic tokens in light/dark:
  - `--app-surface`, `--app-surface-muted`
  - `--timeline-background`, `--timeline-surface`, `--timeline-surface-muted`, `--timeline-grid-minor`, `--timeline-grid-major`, `--timeline-playhead`
  - `--clip-audio`, `--clip-midi`, `--clip-selected`, foregrounds if needed
  - `--meter-safe`, `--meter-warning`, `--meter-clipping`
  - `--device-graph-background`, `--device-graph-grid`, `--device-graph-accent`
  - `--recording`, `--automation`
- Add matching `@theme inline` mappings.

## Phase 4: Tokenize Dashboard

Files:

- `src/components/dashboard/dashboard.tsx`
- `src/components/dashboard/dashboard-sidebar.tsx`
- `src/components/dashboard/dashboard-shared.tsx`
- `src/components/dashboard/general-view.tsx`

Work:

- Replace hardcoded `neutral-*` dark classes with semantic utilities like `bg-background`, `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-sidebar`, and `text-sidebar-foreground`.
- Ensure the theme selector is readable and usable in light, dark, and system modes.

## Phase 5: Tokenize DAW Workspace and Graphics

Files:

- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/TrackLane.tsx`
- `src/components/timeline/TimelineRuler.tsx`
- `src/components/timeline/TrackSidebar.tsx`
- `src/components/timeline/TransportControls.tsx`
- `src/components/timeline/MasterSidebarRow.tsx`
- `src/components/timeline/ClipComponent.tsx`
- `src/components/timeline/GridOverlay.tsx`
- `src/components/timeline/SampleDetailWaveform.tsx`
- `src/components/effects/Eq.tsx`
- `src/components/effects/Compressor.tsx`
- `src/components/effects/Saturator.tsx`

Work:

- Replace foundational dark neutrals with app/timeline tokens.
- Keep domain colors only when they encode state or audio semantics.
- For SVG/canvas literal colors, read CSS variables through a small SSR-safe helper when component behavior requires runtime values.

## Phase 6: Tests and Validation

Commands:

- `bun run typecheck`
- `bun test`
- `git diff --check`

Review:

- Inspect final `git diff` for dead code, duplicate logic, contract drift, invalid CSS variable usage, accidental second persistence source, listener cleanup, and TypeScript rule violations.
