# Dashboard Tracker

> Created: 2026-06-09
> Branch: `dashboard`
> Base branch: `master`
> Scope: redesign app-wide settings, account, project, local file, sample, shortcut, and DAW management into one Dashboard modal modeled after Diffusion.
>
> 1. Build a general **Dashboard**, not a settings-only dashboard.
> 2. Centralize scattered settings and management surfaces into dashboard views.
> 3. Let different entry points open the dashboard to the relevant view.
> 4. Reuse existing DAW primitives and current URL search-param patterns.

## Purpose

This tracker captures the implementation plan for the Dashboard redesign.

The dashboard should be the central modal for app/account/project/workspace management, similar to Diffusion's dashboard model. Settings are only one section inside it. The goal is to provide a durable place for:

- account and session controls
- app and DAW preferences
- project management
- local directories and browser file permissions
- local samples and project media
- keyboard shortcuts
- export defaults and local export state

This tracker should be updated during the branch with implementation notes, rejected candidates, browser evidence, review findings, and final validation artifacts.

---

## Branch

- Current branch: `dashboard`
- Base branch: `master`

---

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Diffusion reference repo: `/Users/juan/Documents/monorepo-new`
- Diffusion dashboard reference files:
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/dashboard.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/sidebar.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/shared.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/types.ts`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/settings-view.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/dashboard/account-view.tsx`
- Current DAW files to inspect before implementation:
  - `src/components/ui/dialog.tsx`
  - `src/routes/index.tsx`
  - `src/lib/location-search-param.ts`
  - `src/components/nav-user.tsx`
  - `src/components/LocalProjectPicker.tsx`
  - `src/hooks/useTimelinePreferences.ts`
  - `src/lib/timeline-storage.ts`
  - `src/lib/local-project-db.ts`
  - `src/lib/local-project-state.ts`
  - `src/lib/session.ts`
  - `src/lib/auth-client.ts`
  - `src/components/ui/Icon.tsx`

---

## Current State

Dashboard-like concerns are currently spread across the app:

1. Account/session actions live in `NavUser`.
2. Project selection and local/cloud project state live in the project picker and route-level project loading flow.
3. Timeline preferences are project-scoped and accessed from timeline-specific surfaces.
4. Local file handles, directories, permissions, samples, and project media are handled by local-first helpers and timeline/project-specific UI.
5. Export settings and status are handled by export dialog/context surfaces.
6. Keyboard shortcuts do not have a central dashboard surface.

The redesign should not create a settings-only modal. It should create a general dashboard shell that can host all of these management areas.

## Accuracy Review Findings

The high-level plan matches Diffusion's dashboard architecture: modal shell, sidebar, URL-backed dashboard view, `showCloseButton={false}`, shared row/section primitives, and view-specific entry points.

Corrections to carry into implementation:

1. A route-level `<Dashboard />` does not automatically have access to live `Timeline` state or actions.
   - Project, Samples, Timeline, and Export views need an explicit ownership model.
   - Prefer passing a dashboard model from `Timeline`/`TransportControls` while a project is open.
   - If no project context exists, these views must degrade to accurate read-only or empty states.
2. Keyboard shortcuts are currently hardcoded in `useTimelineKeyboard`.
   - Do not duplicate shortcut definitions in the dashboard.
   - Either extract a shared shortcut registry used by both the hook and dashboard, or keep the view explicitly static/read-only and note the drift risk.
3. Theme settings need a real theme controller.
   - CSS supports `.dark`, but there is no global theme application layer yet.
   - A theme setting must apply the root class/system preference, or it must not be presented as functional.
4. `confirmDestructiveActions` has no current consumers.
   - Do not persist dead settings.
   - Add it only if delete/archive/destructive flows are wired to read it.
5. Export defaults/directories are not currently persisted.
   - The Export view should first list existing export metadata/status.
   - Add new persistence only if this branch also implements real default export behavior.
6. Sidebar icons need clean typing.
   - `IconName` is not exported today and some dashboard icons may not exist.
   - Update `Icon.tsx` or use existing icon names without unsafe casts.
   - Do not use `as any`.
7. Entry points must include timeline menus, not only `NavUser`.
   - `NavUser` can open Account/General.
   - Timeline Settings, Project, Media, and Export menus need an explicit `onOpenDashboard(view)` path or small URL helper.

---

## Target Architecture

Create a reusable dashboard modal:

```txt
Dashboard modal
  sidebar
    General
    Account
    Projects
    Local Files
    Samples
    Timeline / DAW
    Keyboard Shortcuts
    Export
  content
    selected dashboard view
```

Opening behavior should be view-specific:

```txt
Nav user account item       -> ?dashboard=account
Settings entry              -> ?dashboard=general
Project entry               -> ?dashboard=projects
Local files/directories     -> ?dashboard=files
Samples/media entry         -> ?dashboard=samples
Timeline/DAW entry          -> ?dashboard=timeline
Keyboard shortcuts entry    -> ?dashboard=keyboard
Export defaults/status      -> ?dashboard=export
```

Use one search param:

```txt
?dashboard=general
?dashboard=account
?dashboard=projects
?dashboard=files
?dashboard=samples
?dashboard=timeline
?dashboard=keyboard
?dashboard=export
```

Use `replaceState` for view changes. The dashboard is a modal overlay, not a full navigation destination.

---

## Dashboard Views

Build all primary modal views in this branch.

### General

- App preferences
- Theme only if a real root theme controller is implemented
- Destructive-action confirmation only if destructive flows consume the setting
- Other global DAW behavior

### Account

- Current logged-in user state
- Sign out
- Auth/session state
- Future-ready account/billing/team rows where appropriate, but no fake unavailable controls

### Projects

- Current project metadata
- Local/cloud project state
- Project management actions already exposed elsewhere
- Links/actions currently spread across project picker/nav/menu
- Must receive live project data/actions from the open timeline context, or render read-only/no-project state

### Local Files & Directories

- Local project directories
- Browser file permissions
- Local storage/project access status
- Directory handles or permission state where existing code exposes it

### Samples / Media

- Local samples/media references
- Project sample inventory
- Missing file states
- Imported media management surfaces where existing data exists
- Must not duplicate sample menu state/actions; reuse current project sample data and callbacks where available

### Timeline / DAW

- Timeline defaults
- Grid/snap defaults
- Loop/metronome/default BPM-style preferences where applicable
- Project-scoped settings should clearly say when a project must be open
- Must receive current timeline preferences/actions from timeline context before exposing functional controls

### Keyboard Shortcuts

- Current shortcut list
- Future remapping surface
- Start read-only if no shortcut persistence exists yet
- Do not duplicate hardcoded shortcuts from `useTimelineKeyboard`; extract or share definitions if the list is functional

### Export

- Existing export metadata/status
- Export defaults/preferences only if real persistence and consumers are added
- Local export directory/status only where current export code exposes it
- Supported format defaults where applicable and backed by implementation

---

## Naming and File Structure

Use neutral dashboard naming, not `settings-dashboard`.

New directory:

```txt
src/components/dashboard/
```

Planned files:

| File | Status | Purpose |
|---|---|---|
| `src/components/ui/dialog.tsx` | MODIFY | Add `showCloseButton` prop |
| `src/components/dashboard/types.ts` | NEW | Dashboard view type and parser |
| `src/components/dashboard/dashboard-shared.tsx` | NEW | Scroll view, section, action row, divided stack |
| `src/components/dashboard/dashboard-sidebar.tsx` | NEW | Sidebar item button |
| `src/components/dashboard/dashboard.tsx` | NEW | Modal shell with sidebar and view switch |
| `src/components/dashboard/general-view.tsx` | NEW | App/global preferences |
| `src/components/dashboard/account-view.tsx` | NEW | Session info and sign out |
| `src/components/dashboard/projects-view.tsx` | NEW | Project management and current project state |
| `src/components/dashboard/files-view.tsx` | NEW | Local directories and browser permissions |
| `src/components/dashboard/samples-view.tsx` | NEW | Local/project sample and media state |
| `src/components/dashboard/timeline-view.tsx` | NEW | Timeline/DAW defaults and project-scoped prefs |
| `src/components/dashboard/keyboard-view.tsx` | NEW | Shortcut list and future remapping surface |
| `src/components/dashboard/export-view.tsx` | NEW | Export defaults and local export state |
| `src/lib/app-settings-storage.ts` | NEW | LocalStorage load/save for app-level settings |
| `src/hooks/useAppSettings.ts` | NEW | Signal-based app settings accessor |
| `src/routes/index.tsx` | MODIFY | Wire `dashboard` search param |
| `src/components/nav-user.tsx` | MODIFY | Add dashboard entry points |
| `src/components/timeline/transport-types.ts` | MODIFY | Add dashboard-opening callback/model if project-scoped views are actionful |
| `src/components/timeline/TransportControls.tsx` | MODIFY | Wire timeline menu dashboard entry points |

---

## Dialog Primitive Extension

Modify `src/components/ui/dialog.tsx`.

Add an optional `showCloseButton?: boolean` prop to `DialogContent`.

Default behavior remains unchanged. Existing dialogs should keep their close button. The dashboard will pass `showCloseButton={false}` and own its custom layout.

Prefer this minimal prop over exporting separate portal/overlay/content primitives unless more bespoke dialog layouts prove the need.

---

## Route Integration

Use the current route search-param pattern. Do not migrate `projectId`, `shareToken`, or `dashboard` to TanStack `validateSearch` in this branch.

In `src/routes/index.tsx`:

- add `dashboardView` state
- read `readLocationSearchParam('dashboard')` inside the existing location sync
- add a `setDashboardParam(view: string | null)` helper
- render `<Dashboard view={dashboardView()} setView={setDashboardParam} />`

Use `replaceState`, matching the modal-overlay model.

Project-scoped dashboard data must not be invented at the route level. The route owns URL state and rendering. The open timeline owns timeline/project/sample/export actions and should pass a dashboard model down if actionful views need those controls.

---

## Entry Points

Wire entry points from existing surfaces:

- `NavUser`
  - Account opens `dashboard=account`
  - Settings opens `dashboard=general`
- Project picker or project-related menus
  - Open `dashboard=projects`
- Timeline/file/media surfaces where relevant
  - Open `dashboard=files` or `dashboard=samples`
- Timeline Settings menu
  - Open `dashboard=general`, `dashboard=timeline`, or `dashboard=keyboard` as appropriate
- Timeline Project/Media/Export menus
  - Open `dashboard=projects`, `dashboard=samples`, or `dashboard=export`
- Keyboard shortcuts/help surface, if one exists
  - Open `dashboard=keyboard`
- Export-related surface, if appropriate
  - Open `dashboard=export`

Do not invent fake entry points where no existing user path exists. Prefer wiring real menu actions already present in the app.

---

## App Settings Persistence

Add app-level settings storage for global dashboard preferences.

Proposed `AppSettings`:

```ts
export type AppSettings = {
  theme: 'system' | 'light' | 'dark'
  confirmDestructiveActions?: boolean
}
```

Only include `confirmDestructiveActions` if the same implementation wires existing destructive flows to consume it. Otherwise omit it from `AppSettings` to avoid dead persisted state.

If `theme` is implemented, `useAppSettings()` or a small companion controller must apply the selected theme to the document root and handle `system` preference changes. Do not add a theme control that only writes localStorage.

Storage requirements:

- localStorage key: `daw:app-settings`
- reuse `canUseLocalStorage()` from `timeline-storage`
- defensive JSON parsing
- fallback defaults
- pure load/save functions

Add `useAppSettings()` as a small signal-based hook.

Do not reuse project-scoped persistence helpers for app-wide settings. They carry project lifecycle and async flush behavior that does not belong here.

---

## Implementation Phases

### Phase 1: Shell and Routing

- Create `dashboard` branch.
- Add dialog `showCloseButton` prop.
- Add dashboard view type/parser.
- Add modal shell, sidebar, and shared primitives.
- Wire `?dashboard=` route state.
- Define project-scoped dashboard data ownership before adding actionful project/sample/timeline/export controls.

### Phase 2: Views

- Add all eight dashboard views:
  - General
  - Account
  - Projects
  - Local Files
  - Samples
  - Timeline / DAW
  - Keyboard Shortcuts
  - Export
- Use real existing data where available.
- Use accurate read-only rows where there is no write path yet.
- Do not add fake settings or fake persistence.
- Keep project-scoped views read-only/no-project aware unless timeline context supplies live state/actions.

### Phase 3: Entry Points

- Add dashboard-opening actions from existing nav/menu surfaces.
- Ensure each entry opens the relevant view.
- Keep route-state updates localized and reversible.
- Include timeline Settings, Project, Media, and Export menus through an explicit `onOpenDashboard(view)` callback or URL helper.

### Phase 4: Cleanup and Validation

- Review for duplicate view primitives.
- Remove dead placeholders or unused helpers.
- Run validators.
- Perform browser smoke checks.

---

## Verification Plan

Automated:

- `bun run typecheck`
- `bun run knip`
- `git diff --check`
- `bun run build`

Manual:

- Open each view directly by URL.
- Open dashboard from nav/account/settings/project entry points.
- Switch views and confirm URL updates.
- Close dashboard and confirm `dashboard` param is removed.
- Refresh on each view and confirm the same view opens.
- Verify project open flow still works.
- Verify dashboard works with and without a project open.
- Verify project-scoped views show accurate no-project/read-only states when opened outside a timeline context.
- Verify account view handles logged-in and logged-out states.
- Verify read-only views do not imply unavailable actions are functional.
- Verify theme controls apply visible root theme changes if implemented.
- Verify shortcut display uses shared definitions or is clearly read-only/static.

---

## Review Checklist

- Dashboard is not named or scoped as settings-only.
- All planned views exist.
- Sidebar uses existing icon primitives without unsafe casts if possible.
- Route integration follows current `readLocationSearchParam` convention.
- App settings use app-level storage, not project storage.
- Project-scoped views handle missing project state explicitly.
- Project-scoped action controls are backed by live timeline data/actions.
- Keyboard shortcuts are not duplicated separately from `useTimelineKeyboard`.
- Theme controls do not persist without applying the theme.
- Export defaults/directories are not shown as functional unless implemented.
- No duplicate row/card/sidebar abstractions beyond what views actually use.
- No fake controls for missing persistence.
- Validators and smoke evidence are recorded before merge.
