# Area 4: Import, export, dashboards, routes, preferences, project lifecycle

## Summary

The area already has useful foundations: keyed Solid lists, explicit local-project loading/empty states, shared dialog primitives, cancellable imports, streamed export targets, and a shared byte formatter. The highest-impact gaps are cloud project mutation failures that escape the dashboard, and project/export list loading failures that are presented as indefinite loading or as empty data. Export progress also discards available rendered-frame counts.

## Findings

### IO-01 — A — Cloud project mutation failures escape without user feedback

**Evidence:** `src/components/dashboard/projects-view.tsx:368-374`
> `try { await projectMenu.onRenameProject(project.id, nextName); setRenamingProject(null); } finally { setBusyProjectId(null); }`
> `try { await projectMenu.onDeleteProject(project.id); setDeletingProject(null); } finally { setBusyProjectId(null); }`

**User experience:** A rejected rename/delete leaves the dialog open but has no inline error; the promise is launched with `void` at lines 437 and 444, so a rejection can also become unhandled. The cloud “New project” button likewise invokes its async callback without a busy/error state (`:401-406`).

**Minimal fix:** Give these dashboard actions the same local mutation pattern already used by `LocalProjectsDashboardView` (`:45-89`): a busy guard, caught failure stored for display, and a success-only dialog close. Apply an equivalent visible error/busy state to create.

**Size:** M · **Risk:** low · **Verify:** In the browser dashboard, force each cloud project mutation to reject; confirm the dialog remains open, a useful error appears, and repeated clicks are prevented until settlement.

### IO-02 — A — Local project list failures are shown as “Loading” forever

**Evidence:** `src/components/dashboard/projects-view.tsx:343-346,115-122`
> `const [localProjects] = createResource(..., listLocalProjects)`
> `fallback={<div ...>Loading local projects...</div>}`

**User experience:** When `listLocalProjects` rejects, `localProjects()` remains unavailable, so the dashboard’s loading fallback persists instead of distinguishing failure from loading.

**Minimal fix:** Render `localProjects.error` as an actionable error state and provide a retry by incrementing the existing `localProjectsReloadToken`; keep the current loading and empty states for their respective conditions.

**Size:** S · **Risk:** low · **Verify:** Make the local project listing reject, then confirm an error and retry action replace the spinner-like loading message; resolve the retry and verify the project list appears.

### IO-03 — A — Export history hides loading and errors as “No exports yet”

**Evidence:** `src/hooks/useProjectExports.ts:77-80`; `src/components/dashboard/export-view.tsx:24-26`
> `return Array.isArray(raw.data) ? raw.data : []`
> `fallback={<div ...>No exports yet.</div>}`

**User experience:** Cloud query data that is still loading or failed is converted to an empty array, so users see a false empty state and cannot tell whether history is unavailable.

**Minimal fix:** Return/expose the cloud query’s loading and error state from `useProjectExports`; render loading, error/retry, and true-empty states separately in `DashboardExportView`. Preserve local metadata’s project-scoped stale-result guard (`useProjectExports.ts:44-62`).

**Size:** M · **Risk:** low · **Verify:** Delay and then reject the cloud export-history query; confirm loading and error states are distinct from the no-exports message, then resolve it and verify the list appears.

### IO-04 — B — Export progress ignores rendered-frame counts

**Evidence:** `src/lib/export/run-export-job.ts:1249-1252`; `src/lib/export/export-progress-label.ts:27-36`
> `onProgress?.({ phase: 'rendering', renderedFrames, totalRenderFrames: totalFrames })`
> `if (progress?.phase === 'rendering') return \`${job.name}: Rendering...\``

**User experience:** The native renderer reports current and total frames, but both the overlay and in-dialog status display only “Rendering...”, making long renders appear stalled despite available progress data.

**Minimal fix:** Extend the existing `formatExportProgressLabel` to display a bounded rendered-frame fraction or percentage when both frame values are present; keep its existing phase-only fallback for render paths without counts.

**Size:** S · **Risk:** low · **Verify:** Run an export through the native renderer and observe the progress label advance as rendered frames increase; confirm a path without frame counts still shows the current generic label.

## Looked at and fine

- **Import errors and cancellation:** `useTimelineClipImport` reports per-file failures through the existing `notify('Audio import failed', ...)` path and checks abort/project-generation state (`src/hooks/useTimelineClipImport.ts:326-359,426-510`). Local asset writes stream in bounded chunks and abort their writable on failure (`src/lib/local-assets.ts:84-116`). No claim of a general import partial-state leak is supported by the inspected paths.
- **Export target separation:** Browser and desktop factories have intentionally different picker/stream/capability behavior behind the shared `ExportOutputTargetFactory` contract (`src/lib/export/export-output-targets.ts:11-43`, `src/lib/export/browser-export-output-targets.ts:35-65`, `src/lib/desktop/capability-export-output-targets.ts:94-120,145-203`). This is platform adaptation, not confirmed duplicate picker logic.
- **Export cancel/recovery:** The export queue aborts active jobs and resolves queued cancellation (`src/lib/export/export-queue.ts:89-114`); the export runner aborts a partially written sink and disposes output targets (`src/lib/export/run-export-job.ts`, export output loop and finalization paths around lines 1290-1410). No concrete partial-output defect was established.
- **Dialog behavior:** Shared `DialogContent` uses Kobalte’s dialog content/close primitives (`src/components/ui/dialog.tsx:59-87`), and the project rename/delete dialogs reuse that shell. No verified Escape or focus-restoration failure was found.
- **Lists and bounded file work:** Project, sample, export, and dashboard navigation collections use Solid `<For>` (`src/components/dashboard/projects-view.tsx:132`, `src/components/dashboard/samples-view.tsx:59`, `src/components/dashboard/export-view.tsx:28`, `src/components/dashboard/dashboard.tsx:57`). Audio metadata reads use a capped MediaBunny blob cache (`src/lib/media/audio-file-metadata.ts:5,27-29`), and resumable upload parts are sliced to protocol-sized chunks (`src/lib/resumable-audio-uploader.ts:304-316`).
- **Duplication checks:** Export format metadata is sourced from shared `getExportAudioFormatMetadata` in the inspected UI/progress paths; byte formatting is centralized in `src/lib/format-bytes.ts` and reused by the progress label. The duration formatter found in `samples-view.tsx:10` is a single scoped helper, not an identical duplicate in the searched source.
- **Preferences, theme, sign-in, save status, and routes:** Preferences normalize persisted data (`src/lib/preferences/app-preferences.ts:23-33,35-55`); theme resolution has a single registry/resolver path; login and OAuth consent expose visible error/loading or submitting feedback; root route errors have a fallback. No specific behavior defect was verified in these inspected paths.
- **Dead code:** No scoped dead export or file was claimed. Repository-wide symbol searches showed the browser/desktop export factories used by `src/context/export.tsx` and the capability factory used by the attached host. No checked candidate met the evidence bar for dead code.
