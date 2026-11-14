# Area 6: Persistence, undo, sync, collaboration, backend

## Summary

The project has deliberate local write batching, durable shared-operation queuing, and bounded control history. The main user-facing gaps are that queued local timeline writes are not reflected in save status, failed shared changes expose little diagnostic context and are not retried automatically while the app stays online, and failed undo/redo operations only reach the console. Shared chat also reads the full room history for every live query despite returning only the latest page.

Findings are limited to behaviors visible in the current working tree. No source files were changed and no builds, tests, apps, or external services were run.

## Findings (sorted by user impact)

### PS-01
- **Category:** A
- **Title:** Local save badge ignores queued timeline writes and write failures
- **Evidence:** `src/lib/local-write-queue.ts:93-100`
  > `void this.flush().catch((error) => {`
  > `  console.error('Failed to flush local entity writes', error)`
  > `})`
  `src/lib/project-save-status.ts:79-80` reports local projects as “Saved locally on this device” without any local timeline-queue state; `src/lib/timeline-repository/local-timeline-repository.ts:417-426` separately tracks and flushes pending writes.
- **What the user experiences:** The project can display “Saved locally” while a timeline write is still queued or has failed and is retrying. The retry is capped, but its failure state never reaches the badge.
- **Minimal fix sketch:** Include local timeline write-queue pending/failure state in the project save-status input, and only report saved after the durable IndexedDB transaction succeeds. Preserve the existing queue and status wording pattern.
- **Size:** M
- **Risk:** med
- **How to verify:** In a browser test, force an IndexedDB write failure after editing a local clip. Confirm the badge changes from saved to a pending/failed state, remains so through retry, and returns to saved after a successful flush.

### PS-02
- **Category:** A
- **Title:** Shared sync failures lack useful status and can remain idle indefinitely
- **Evidence:** `src/lib/shared-outbox.ts:1043-1057` records the underlying `lastError` and schedules a later retry. `src/hooks/useTimelinePersistenceController.ts:83-89` starts a flush at project mount and on the browser `online` event, swallowing flush errors; `src/hooks/useLocalProjectActions.ts:216-222` retries only through an explicit user action.
- **What the user experiences:** A transient failure can stay queued until another online transition, remount, or manual retry. The status badge reduces failures to counts (`src/lib/project-save-status.ts:55-63`), so the user cannot tell why a change failed or whether it needs a different action.
- **Minimal fix sketch:** Schedule a bounded retry at the earliest eligible `nextAttemptAt` while the project remains active, cancel it on cleanup, and expose a concise failure reason or actionable status through the existing save-status surface. Keep permanent rejections distinct from transient retries.
- **Size:** M
- **Risk:** med
- **How to verify:** With a browser-observable network-failure test, queue a shared edit, remain online, then restore connectivity without toggling offline/online. Confirm it retries after backoff, reports pending/failed accurately, and clears when published; separately verify a permanent rejection explains the failure.

### PS-03
- **Category:** A
- **Title:** Failed undo/redo silently leaves the user without an explanation
- **Evidence:** `src/hooks/useTimelineHistory.ts:381-385`
  > `} catch (error) {`
  > `  if (mode === 'undo') manager.restoreUndo(entry)`
  > `  else manager.restoreRedo(entry)`
  > `  console.error(\`[Timeline] ${mode} failed\`, error)`
- **What the user experiences:** The history entry is correctly restored for another attempt, but the operation failure is only visible in developer tools. A user sees no reason when a cloud conflict or persistence error prevents the requested undo/redo.
- **Minimal fix sketch:** Keep restoring the reservation, and route a concise failure notification through the existing timeline notification callback. Avoid presenting raw internal errors unless they are safe and actionable.
- **Size:** S
- **Risk:** low
- **How to verify:** In a browser test, make the persistence adapter reject an undo. Confirm the history entry remains undoable and an accessible notification explains that undo did not complete.

### PS-04
- **Category:** B
- **Title:** Shared chat live query reads every message to return only the latest 200
- **Evidence:** `convex/sharedChat.ts:12-20`
  > `.withIndex("by_room_createdAt", (q) => q.eq("projectId", projectId))`
  > `.collect();`
  > `const n = Math.max(1, Math.min(500, limit ?? 200));`
  > `const recent = rows.slice(start);`
- **What the user experiences:** Every room message update re-runs a query that collects the entire room history, even though the client requests 200 messages. Query work and transferred reactive data grow with the room's lifetime rather than the visible chat window.
- **Minimal fix sketch:** Query the existing room/created-at index in descending order with the bounded limit, then reverse the selected rows for chronological display. Confirm the index ordering and cursor behavior preserve current ordering semantics.
- **Size:** S
- **Risk:** low
- **How to verify:** Seed a room with substantially more than 200 messages, open chat, then send one message. Confirm the result remains chronological and bounded to the requested latest messages; inspect query results/reads to ensure older rows are not collected.

## Looked at and fine

- Undo entries are capped at 50 by default, and pushes clear redo (`src/lib/undo/manager.ts:109-110, 148-152`). Merge behavior is explicitly keyed and time-windowed; clip-drag history is pushed from the committed drag path rather than pointer movement (`src/lib/clip-drag-commit.ts:109-133`).
- Local repository writes coalesce entity puts/deletes by entity key and batch them in a single IndexedDB transaction (`src/lib/local-write-queue.ts:38-40, 64-75, 108-123`). This is not a full-project serialization per small edit.
- Project save status distinguishes unknown cloud sync state, pending/failed shared changes, local-save failures, and backup failures (`src/lib/project-save-status.ts:37-87`). The issue is specifically the missing local timeline queue integration identified in PS-01.
- Backup conflicts return a conflict result and the UI presents local/cloud timestamps and explicit overwrite, restore, or duplicate choices (`src/lib/cloud-backup.ts:347-355`; `src/hooks/useLocalProjectActions.ts:66-75, 109-123`).
- The inspected Convex schema defines indexes for the project-scoped hot reads in scope, including timeline entities, control history/recoveries, and chat (`convex/schema.ts:20-21, 71-72, 300-302, 332-333, 441-442`).
- No unused Convex functions or API routes are reported: repository-wide `api.*` searches showed active callers for inspected candidates, and compatibility contracts in `docs/control-platform.md` make removal claims especially inappropriate without consumer evidence.
- No cross-package validation/helper duplication is reported. The focused reads and usage searches did not establish a concrete harmful duplicate requiring a finding.
