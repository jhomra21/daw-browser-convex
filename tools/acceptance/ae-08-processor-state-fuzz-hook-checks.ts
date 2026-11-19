export type TraceEvent =
  | { kind: "reserve"; order: number; gain: number }
  | { kind: "release"; order: number }
  | { kind: "allocate"; order: number; gain: number; fresh: boolean }
  | { kind: "replay"; gain: number; applications: number }
  // The panel's own value read back right after a replay returned: the replay's content actually applied.
  | { kind: "applied"; instanceId: string; gain: number }
  // The effective projection took a new canonical edit (own-write echo, external, history).
  | { kind: "projection"; target: string; order: number; id: string; gain: number }
export type Mark = {
  // The effective value the panel shows (a gesture's preview included), and the committed one (the release or replay beneath it).
  knob: number
  committed: number
  native: number | null
  persisted?: number
  applicationCount: number
  editSequence: number
  historyFailures: number
  rebuilds: number
  removedRebuilds: number
  trace: number
  persistenceFailures: number
  panelErrors: number
  aborts: number
  coldInstalls: number
  prepares: number
  publishes: number
  assets: number[]
  sources: number[]
  value?: number
}
export type ContextFields = {
  bpm: number | undefined; numerator: number | undefined; denominator: number | undefined; cycle: boolean | undefined
  cycleStart: number | undefined; cycleEnd: number | undefined
}
type Application = { gain: number | null; strategy: string }
export type ChecksContext = {
  marks: ReadonlyMap<string, Mark>
  mark: () => Mark
  trace: readonly TraceEvent[]
  history: () => { canUndo: boolean; canRedo: boolean }
  applicationsSince: (count: number) => Application[]
  quiescent: () => boolean
  settled: (waiter: string) => boolean
  // Whether a waiter of this name is still pending.
  unanswered: (waiter: string) => boolean
  // Whether a waiter settled with a rejected (`handled: false`) result.
  refused: (waiter: string) => boolean
  context: () => { published: ContextFields | undefined; projected: ContextFields }
  fail: (invariant: string, detail: string, failureClass?: string) => void
  checked: (invariant: string) => void
}

const required = (marks: ReadonlyMap<string, Mark>, name: string) => {
  const mark = marks.get(name)
  if (!mark) throw new Error(`A2c witness is missing mark ${name}`)
  return mark
}
const quiet = (ctx: ChecksContext, mode: string) => {
  if (!ctx.quiescent()) throw new Error(`${mode} witness has unresolved scheduler dependencies`)
}

// The history operation that started at `pre`: its reservation, the replay it
// entered, and the allocation that replay took.
const historyEvents = (ctx: ChecksContext, pre: Mark) => {
  const events = ctx.trace.slice(pre.trace)
  const reserve = events.find((event) => event.kind === "reserve")
  const replayAt = events.findIndex((event) => event.kind === "replay")
  const replay = replayAt < 0 ? undefined : events[replayAt]
  const replayAllocation = events.slice(Math.max(replayAt, 0)).find((event) => event.kind === "allocate" && replayAt >= 0)
  const replayEvent = replay?.kind === "replay" ? replay : undefined
  const allocation = replayAllocation?.kind === "allocate" ? replayAllocation : undefined
  // The panel write of the replayed content, read back after the replay returned.
  const applied = events.slice(Math.max(replayAt, 0)).find((event) => event.kind === "applied" && replayAt >= 0)
  const panelWrite = applied?.kind === "applied" ? applied : undefined
  // A canonical projection of the same Utility target, after the replay's allocation (the effective projection of an open
  // gesture's preview is emitted synchronously inside the replay, before it returns), with a higher edit order than the
  // replay and other content.
  const allocationAt = events.findIndex((event) => event === allocation)
  const replacement = allocationAt < 0 || !applied ? undefined : events.slice(allocationAt + 1).find((event) => event.kind === "projection"
    && event.target === "track:utility:1" && allocation !== undefined && event.order > allocation.order && event.gain !== replayEvent?.gain)
  return { events, reserve, replay: replayEvent, replayAllocation: allocation, panelWrite,
    replacement: replacement?.kind === "projection" ? replacement : undefined }
}

// A2c witnesses. Native proof is the host's applied-content record, never the
// controller's receipts; the panel value and the persisted row are independent.
// Returns false for modes owned by the hook fixture.
export default function a2cChecks(mode: string, ctx: ChecksContext): boolean {
  const now = ctx.mark()
  if (mode === "history-undone" || mode === "history-redone") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const pre = required(ctx.marks, "pre-history")
    const { reserve, replay, replayAllocation, panelWrite } = historyEvents(ctx, pre)
    const state = ctx.history()
    // Reservation, successful persistence (the reserve was never released), replay entry,
    // replay allocation and bridge application are separate observations.
    const adopted = pre.knob === reserve?.gain ? replayAllocation?.order === reserve?.order : true
    // Admission: the replayed content appears in a published graph (`applications` records the graph's own value).
    // When the panel already showed the value, the graph already carries it and no new application is due.
    const admitted = pre.knob === pre.value
      || ctx.applicationsSince(replay?.applications ?? now.applicationCount).some((entry) => entry.gain === pre.value)
    if (!reserve || !replay || !replayAllocation || replay.gain !== pre.value || !adopted || !admitted
      || panelWrite?.gain !== pre.value || panelWrite.instanceId !== "utility:1"
      || now.historyFailures !== pre.historyFailures || now.knob !== pre.value
      || (mode === "history-undone" ? !state.canRedo : !state.canUndo || state.canRedo))
      ctx.fail("I1", `${mode} did not complete a replayed history operation (reserve ${JSON.stringify(reserve)}, replay ${JSON.stringify(replay)}, allocation ${JSON.stringify(replayAllocation)}, panel write ${JSON.stringify(panelWrite)}, admitted ${admitted}, panel ${now.knob}, history ${JSON.stringify(state)})`, "edit-identity")
    // Native must play what the replayed panel shows; a replay that reaches native only
    // through a graph prepare, under a retained live override, is the later-owned symptom.
    else if (now.native !== pre.value)
      ctx.fail("I1", `${mode}: replay entered and was ordered, but native plays ${now.native} while the panel shows ${now.knob}`, "graph-only-desired-change")
    return true
  }
  if (mode === "history-return") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const away = required(ctx.marks, "away-start")
    const gains = ctx.applicationsSince(away.applicationCount).map((entry) => entry.gain)
    const awayIndex = gains.indexOf(-3)
    // The undo consumed its reservation, so the move away and the return are two fresh edits.
    if (now.native !== 0 || now.knob !== 0 || awayIndex < 0 || gains.lastIndexOf(0) < awayIndex
      || now.editSequence - away.editSequence < 2)
      ctx.fail("I1", `Equal-current undo, move away and back: the return did not reach the bridge (native ${now.native}, panel ${now.knob}, applied ${JSON.stringify(gains)})`, "edit-identity")
    return true
  }
  if (mode === "history-newer") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const pre = required(ctx.marks, "pre-undo")
    const { events, reserve, replay, replayAllocation, panelWrite, replacement } = historyEvents(ctx, pre)
    const newer = events.find((event) => event.kind === "allocate" && event.gain === pre.value && event.fresh)
    // A newer write retired the reservation, so the replay is ordered at arrival after it.
    const ordered = reserve && newer?.kind === "allocate" && replay && replayAllocation
      && newer.order > reserve.order && replayAllocation.order > newer.order && replayAllocation.fresh
    // The replay must have written its content to the panel (target and content read back), and
    // that content must reach a published graph unless a traced later canonical projection with a
    // higher order replaced it. A final panel value alone is not evidence of replacement.
    const written = panelWrite?.instanceId === "utility:1" && panelWrite.gain === replay?.gain
    const admitted = written && (replacement !== undefined
      || (replay !== undefined && ctx.applicationsSince(replay.applications).some((entry) => entry.gain === replay.gain)))
    // A gesture still open owns native until it ends. Before it is committed the history write is the
    // only canonical one, so the panel and the persisted row must already hold the replayed content.
    const open = required(ctx.marks, "open").value === 1
    if (!ordered)
      ctx.fail("I1", `History replay did not take a fresh order after the newer edit (reserve ${JSON.stringify(reserve)}, newer ${JSON.stringify(newer)}, replay ${JSON.stringify(replay)}, allocation ${JSON.stringify(replayAllocation)})`, "edit-identity")
    else if (!written)
      ctx.fail("I1", `History replay took order ${replayAllocation?.order} but never wrote its content to the panel (panel write ${JSON.stringify(panelWrite)}, replay ${replay?.gain})`, "edit-identity")
    else if (!admitted)
      ctx.fail("I1", `History replay (order ${replayAllocation?.order}) was written to the panel and ordered after the newer edit (order ${newer?.kind === "allocate" ? newer.order : undefined}) but neither reached a published graph nor was replaced by a later projection; trace ${JSON.stringify(events)}`, "edit-identity")
    // The open gesture's live preview reaches native by its own dispatch; its later commit would hide a dropped one.
    else if (open && now.native !== pre.value)
      ctx.fail("I1", `Open gesture preview ${pre.value} did not reach native (native plays ${now.native})`, "live-preview-not-applied")
    else if (open && (now.committed !== replay?.gain || now.persisted !== replay?.gain))
      ctx.fail("I10", `Before the open gesture commits, the history write should be canonical: committed ${now.committed}, persisted ${now.persisted}, replay ${replay?.gain}`, "edit-identity")
    else if (!open && now.native !== now.knob)
      ctx.fail("I1", `History replay is admitted but native plays ${now.native} while the panel shows ${now.knob}`, "graph-only-desired-change")
    return true
  }
  if (mode === "history-agreement") {
    quiet(ctx, mode)
    ctx.checked("I10")
    // Which write should win is persistence policy; the persisted row, the panel and native
    // must still agree once everything has settled.
    if (now.persisted !== now.knob)
      ctx.fail("I10", `Persisted ${now.persisted} and panel ${now.knob} disagree after a history save raced a newer gesture`, "panel-save-cancel-ownership")
    else if (now.native !== now.knob)
      ctx.fail("I1", `Native plays ${now.native} while the panel shows ${now.knob} after a history save raced a newer gesture`, "graph-only-desired-change")
    return true
  }
  if (mode === "history-failed-undo") {
    quiet(ctx, mode)
    ctx.checked("I10")
    const before = required(ctx.marks, "pre-undo")
    if (now.historyFailures !== before.historyFailures + 1) throw new Error("History failure witness did not fail a save")
    const replayed = ctx.applicationsSince(before.applicationCount).some((entry) => entry.gain === before.value)
    if (replayed || now.knob !== before.knob || now.native !== before.native)
      ctx.fail("I10", `A failed history save replayed the undone value (panel ${now.knob}, native ${now.native})`, "edit-identity")
    return true
  }
  if (mode === "history-failed-next") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const failed = required(ctx.marks, "post-failure")
    // The next write equals the undone target: a retained reservation would reuse its older order.
    if (now.editSequence <= failed.editSequence || now.native !== failed.value || now.knob !== failed.value)
      ctx.fail("I1", `The gesture after a failed history save did not take a fresh order and reach native (panel ${now.knob}, native ${now.native})`, "edit-identity")
    return true
  }
  if (mode === "save-fail-open") {
    quiet(ctx, mode)
    ctx.checked("I10")
    // The newer gesture is still open: a failed save of the older edit must not
    // have rolled native back over it or over the external winner.
    const external = required(ctx.marks, "external").value === 1
    if (now.native !== -13 && !(external && now.native === -11))
      ctx.fail("I10", `Cell ${required(ctx.marks, "cell").value}: failed save overwrote the newer winner while the gesture is open (native ${now.native})`, "panel-save-cancel-ownership")
    return true
  }
  if (mode === "save-fail-final") {
    quiet(ctx, mode)
    ctx.checked("I10")
    const expected = required(ctx.marks, "expected").value
    const failed = required(ctx.marks, "category").value === 1
    // A failed-save cell observes exactly one write abort and its product failure callback;
    // an after-success cell observes neither.
    if (now.aborts !== (failed ? 1 : 0) || now.persistenceFailures !== (failed ? 1 : 0))
      throw new Error(`Save cell ${required(ctx.marks, "cell").value} (${failed ? "failed" : "after-success"}) saw ${now.aborts} aborts and ${now.persistenceFailures} failure callbacks`)
    if (now.knob !== expected || now.native !== expected)
      ctx.fail("I10", `Cell ${required(ctx.marks, "cell").value}: newest write ${expected} lost (panel ${now.knob}, native ${now.native})`, "panel-save-cancel-ownership")
    if (now.persisted !== now.knob)
      ctx.fail("I10", `Cell ${required(ctx.marks, "cell").value}: persisted ${now.persisted} differs from panel ${now.knob}`, "panel-save-cancel-ownership")
    return true
  }
  if (mode === "cancel-other-save") {
    quiet(ctx, mode)
    ctx.checked("I10")
    // The last canonical value is the earlier edit's save, which the cancel's stored-row read predates.
    const expected = required(ctx.marks, "expected").value
    if (now.persisted !== expected || now.knob !== expected)
      ctx.fail("I10", `${mode}: panel ${now.knob} and persisted ${now.persisted} should hold ${expected}`, "panel-save-cancel-ownership")
    else if (now.native !== expected)
      ctx.fail("I1", `${mode}: native plays ${now.native} while the panel and the stored row hold ${expected}`, "graph-only-desired-change")
    return true
  }
  if (mode === "gesture-ended") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const expected = required(ctx.marks, "expected").value
    if (now.knob !== expected)
      ctx.fail("I10", `${mode}: panel ${now.knob} should show the external write ${expected}`, "panel-save-cancel-ownership")
    else if (now.native !== expected)
      ctx.fail("I1", `${mode}: native plays ${now.native} while the panel shows ${expected} after the gesture ended`, "graph-only-desired-change")
    return true
  }
  if (mode === "patch-install") {
    quiet(ctx, mode)
    ctx.checked("I1")
    // A patch queued behind a newer gesture installs its own state, which zeroes the slot's overrides: native, the
    // panel and the stored row must still all end on the gesture, and no patch may be rejected after native took it.
    const expected = required(ctx.marks, "expected").value
    if (now.native !== expected)
      ctx.fail("I1", `${mode}: native plays ${now.native} after the patches installed, the gesture ended on ${expected}`, "patch-install-erased-override")
    else if (now.knob !== expected || now.persisted !== expected)
      ctx.fail("I10", `${mode}: panel ${now.knob} and persisted ${now.persisted} should hold ${expected}`, "patch-install-erased-override")
    if (ctx.refused("gain-patch"))
      ctx.fail("I3", `${mode}: a patch settled rejected although native installed it`, "claimed-patch-settled-as-rejected")
    return true
  }
  if (mode === "commit-removal") {
    const before = required(ctx.marks, "pre-commit")
    ctx.checked("I9")
    // The late commit callback must have run and settled, independently of any rebuild.
    if (!ctx.settled("late-commit")) throw new Error("Removal witness: the late commit callback did not settle")
    if (now.rebuilds > before.rebuilds || now.coldInstalls > before.coldInstalls)
      ctx.fail("I9", "A commit after member removal reached rebuildPlaybackBackend or a native stop/configure/cold install instead of being cancelled", "commit-after-removal-rebuild")
    return true
  }
  if (mode === "context-published") {
    quiet(ctx, mode)
    ctx.checked("I1")
    const { published, projected } = ctx.context()
    // Every settled tempo/meter/loop group, bounds included, must be what native plays.
    if (JSON.stringify(published) !== JSON.stringify(projected))
      ctx.fail("I1", `Published native musical context ${JSON.stringify(published)} differs from projection ${JSON.stringify(projected)}`, "stale-compile")
    return true
  }
  if (mode === "asset-held") {
    const held = required(ctx.marks, "asset-hold")
    ctx.checked("I1")
    if (held.value !== 1) ctx.fail("I1", "Superseding compile never reached a held candidate asset preparation", "stale-compile")
    return true
  }
  if (mode === "identity-unchanged") {
    quiet(ctx, mode)
    ctx.checked("I6")
    // B1's gate: with no publication since the preview, the binding is unchanged and the flush
    // dispatches nothing additional.
    const extra = required(ctx.marks, "unchanged-flush").value
    if (extra !== 0)
      ctx.fail("I6", `An unchanged terminal flush allocated ${extra} additional dispatches`, "edit-identity")
    return true
  }
  if (mode === "ending-flush") {
    const expected = required(ctx.marks, "expected").value
    ctx.checked("I7"); ctx.checked("I10")
    if (!ctx.settled("flush")) ctx.fail("I7", "The flush of the ended domain was never answered", "late-reply-domain")
    if (now.panelErrors) ctx.fail("I10", "The panel reported an error for a flush that live control cancelled", "cancelled-draft-persistence")
    if (now.knob !== expected || now.persisted !== expected)
      ctx.fail("I10", `The panel knob ${now.knob} and persisted row ${now.persisted} should hold the still-desired ${expected}`, "cancelled-draft-persistence")
    // A null native has no session to hold the value; the next prepare carries it.
    else if (now.native !== null && now.native !== expected)
      ctx.fail("I1", `Content still desired when its domain ended was never executed again: native ${now.native}, desired ${expected}`, "ending-domain-stranded")
    return true
  }
  if (mode === "paused-flush") {
    quiet(ctx, mode)
    ctx.checked("I4")
    ctx.checked("I10")
    const timers = required(ctx.marks, "timers").value
    const expected = required(ctx.marks, "expected").value
    // The hook's own structural dispose can end the session before the commit reaches live control, so there may be no
    // flush at all. One that was sent is answered (by progress, or cancelled with its session) and never by a timer.
    const unanswered = ctx.unanswered("flush")
    if (unanswered || timers !== 0)
      ctx.fail("I4", `Prepared paused flush did not settle by progress or proof (flush unanswered ${unanswered}, timer rescues ${timers}, native ${now.native})`, "paused-prepared-flush")
    if (now.knob !== expected || now.persisted !== expected)
      ctx.fail("I10", `The panel knob ${now.knob} and persisted row ${now.persisted} should hold the still-desired ${expected}`, "cancelled-draft-persistence")
    return true
  }
  return false
}
