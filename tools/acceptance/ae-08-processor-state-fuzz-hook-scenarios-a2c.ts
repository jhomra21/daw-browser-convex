import type createHookFixture from "./ae-08-processor-state-fuzz-hook"
import type { Action } from "./ae-08-processor-state-fuzz-host"

type Fixture = Awaited<ReturnType<typeof createHookFixture>>
export type A2cDriver = { fixture: Fixture; act: (action: Action) => Promise<void>; drain: () => Promise<void>
  until: (predicate: () => boolean) => Promise<void>; seed: number }

// Cell scenarios run one exact cell per seed; the cell count is part of the evidence.
const savePermutations = [["G2", "F", "E"], ["G2", "E", "F"], ["F", "G2", "E"], ["F", "E", "G2"], ["E", "G2", "F"], ["E", "F", "G2"]]
const withoutExternal = [["G2", "F"], ["F", "G2"]]
const gaps = 3
// The newer gesture lands while the history write is not yet created, just open, or open after more tasks.
const historyPositions = 3
const cellCount = (name: string) => name === "history-save-newer" ? historyPositions * 2 // 3 positions x open/committed gesture
  : name === "save-fail-positions" ? savePermutations.length * gaps ** 3 + withoutExternal.length * gaps ** 2 : 1
export const a2cScenarios = ["history-equal-undo-return", "history-redo", "history-save-newer", "history-save-failed", "save-fail-positions",
  "commit-after-removal", "context-matrix", "stale-compile-asset-wait", "candidate-page-hold", "sample-swap", "sample-swap-window",
  "paused-flush", "identity-unchanged", "cancel-other-save", "instrument-urgent", "gesture-equal-return", "gesture-cancel-unchanged",
  "gesture-multi-field-return", "gesture-multi-field-cancel", "pause-refused-pending", "refused-batch-publication-no-pause",
  "preview-across-pause", "processor-timer"]

export default async function runA2cScenario(name: string, driver: A2cDriver) {
  const { fixture, act, drain, until, seed } = driver
  const idbTasks = async (count: number) => {
    for (let index = 0; index < count; index++) {
      const task = fixture.time.enabled().find((entry) => entry.kind === "idb-task")
      if (!task) return
      await act({ kind: "idb-task", id: task.id })
    }
  }
  // Context publication and schedule adoption ride native progress, so a change settles only after audio renders.
  const rendered = async () => {
    for (let count = 0; count < 6; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
  }
  const settled = async () => { await drain(); await act({ kind: "observe-persisted" }); await drain() }
  // The first effect write started after `base`: the write a history operation or save began.
  const writeSince = (base: number) => fixture.state().effectTransactions.find((entry) => entry.ordinal > base)
  const writesStarted = () => fixture.state().effectWrites.started
  const completeWrite = async (base: number) => {
    for (let count = 0; count < 200 && writeSince(base)?.state === "open"; count++) await idbTasks(1)
    if (writeSince(base)?.state === "open") throw new Error("Held write never completed")
  }
  // Hold the next control command named `command` (a real deferred native completion) without delivering it.
  const hold = async (command: string) => {
    await until(() => fixture.state().pendingControl?.name === command)
    await act({ kind: "mark", mode: "asset-hold", value: fixture.state().pendingControl?.name === command ? 1 : 0 })
  }
  const cell = (seed - 1) % cellCount(name)
  if (name === "history-equal-undo-return") {
    // The value history restores equals the value the project already shows.
    await act({ kind: "gain", value: -6 }); await drain()
    await act({ kind: "external-adoption", value: 0 }); await settled(); await rendered()
    await act({ kind: "mark", mode: "pre-history", value: 0 })
    // The project already shows the value history will restore.
    if (fixture.state().knob !== 0 || fixture.state().persistedGain !== 0) throw new Error("Equal-current witness does not start at the restored value")
    await act({ kind: "undo" }); await settled(); await rendered()
    await act({ kind: "check", mode: "history-undone" })
    await act({ kind: "mark", mode: "away-start" })
    await act({ kind: "gain", value: -3 }); await drain()
    await act({ kind: "arm-drop", value: 1 })
    await act({ kind: "gain", value: 0 }); await drain()
    await act({ kind: "arm-drop", value: 0 })
    await settled()
    await act({ kind: "check", mode: "history-return" })
  } else if (name === "history-redo") {
    await act({ kind: "gain", value: -6 }); await drain()
    await act({ kind: "mark", mode: "pre-history", value: 0 })
    await act({ kind: "undo" }); await settled(); await rendered()
    await act({ kind: "check", mode: "history-undone" })
    await act({ kind: "mark", mode: "pre-history", value: -6 })
    await act({ kind: "redo" }); await settled(); await rendered()
    await act({ kind: "check", mode: "history-redone" })
  } else if (name === "history-save-newer") {
    // A newer local gesture lands while the history write is held at an exact lifecycle position,
    // as a gesture left open or as a committed write.
    const position = Math.floor(cell / 2)
    await act({ kind: "gain", value: -6 }); await drain()
    await act({ kind: "mark", mode: "pre-undo", value: -13 })
    const base = writesStarted()
    await act({ kind: "undo" })
    // position 0: the write is not created yet; 1: open before any task; 2: open after further tasks.
    if (position === 0) { if (writeSince(base)) throw new Error("History write already exists at position 0") }
    else {
      for (let count = 0; count < 200 && !writeSince(base); count++) await idbTasks(1)
      if (position === 2) await idbTasks(2)
    }
    const landing = writeSince(base)
    if (position > 0 && landing?.state !== "open") throw new Error(`History write is not open at position ${position}`)
    const open = cell % 2 === 0
    await act({ kind: "arm-drop", value: 1 })
    await act({ kind: open ? "preview" : "gain", value: -13 })
    await completeWrite(base)
    await settled(); await rendered()
    await act({ kind: "mark", mode: "open", value: open ? 1 : 0 })
    await act({ kind: "check", mode: "history-newer" })
    // The planted dispatch drop stays armed until the checkpoint, so a later resend cannot heal it.
    await act({ kind: "arm-drop", value: 0 })
    // An open gesture ends after the replay and is then the newest write; a committed one
    // landed before it, so the replay is.
    if (open) { await act({ kind: "commit" }); await settled(); await rendered() }
    await act({ kind: "check", mode: "history-agreement" })
  } else if (name === "history-save-failed") {
    await act({ kind: "gain", value: -6 }); await drain()
    await act({ kind: "mark", mode: "pre-undo", value: 0 })
    await act({ kind: "undo" })
    await until(() => fixture.time.canFailPersistence())
    await act({ kind: "persist-fail" })
    await drain()
    await act({ kind: "check", mode: "history-failed-undo" })
    await act({ kind: "mark", mode: "post-failure", value: 0 })
    await act({ kind: "gain", value: 0 }); await settled()
    await act({ kind: "check", mode: "history-failed-next" })
  } else if (name === "save-fail-positions") {
    // A save (F), a newer local gesture (G2) and a later external projection (E), each placed after
    // 0..2 IDB tasks, in every order. F aborts the save only while its write is open; a cell whose
    // write already completed is the after-success category and sees no failure.
    const external = cell < savePermutations.length * gaps ** 3
    const order = external ? savePermutations[cell % savePermutations.length] : withoutExternal[(cell - savePermutations.length * gaps ** 3) % withoutExternal.length]
    const spacing = external ? Math.floor(cell / savePermutations.length) : Math.floor((cell - savePermutations.length * gaps ** 3) / withoutExternal.length)
    if (!order) throw new Error(`No save-fail cell ${cell}`)
    const base = writesStarted()
    await act({ kind: "gain", value: -6 })
    await until(() => writeSince(base)?.state === "open")
    const landings: string[] = []
    let failed = false
    for (const [index, event] of order.entries()) {
      await idbTasks(Math.floor(spacing / gaps ** index) % gaps)
      const state = writeSince(base)?.state ?? "missing"
      landings.push(`${event}@${state}`)
      if (event === "G2") await act({ kind: "preview", value: -13 })
      else if (event === "E") await act({ kind: "external-adoption", value: -11 })
      else if (state === "open") { await act({ kind: "persist-fail" }); failed = true }
    }
    await drain()
    await act({ kind: "mark", mode: "cell", value: cell })
    await act({ kind: "mark", mode: "external", value: external ? 1 : 0 })
    await act({ kind: "check", mode: "save-fail-open" })
    // The open gesture ends; the project then shows the last canonical write.
    await act({ kind: "cancel" })
    await act({ kind: "mark", mode: "category", value: failed ? 1 : 0 })
    await act({ kind: "mark", mode: "landings:" + landings.join(","), value: cell })
    await act({ kind: "mark", mode: "expected", value: external ? -11 : failed ? 0 : -6 })
    await settled()
    await act({ kind: "check", mode: "save-fail-final" })
  } else if (name === "commit-after-removal") {
    await act({ kind: "membership", value: 0 }); await drain()
    await act({ kind: "mark", mode: "pre-commit" })
    await act({ kind: "late-commit", value: -9 }); await drain()
    await act({ kind: "check", mode: "commit-removal" })
    await act({ kind: "check", mode: "drained" })
  } else if (name === "context-matrix") {
    // Each settled group must publish exactly the projected tempo, meter and loop bounds.
    await act({ kind: "tempo", value: 90 }); await act({ kind: "tempo", value: 200 })
    await act({ kind: "meter", value: 3 }); await act({ kind: "loop" }); await drain(); await rendered()
    await act({ kind: "check", mode: "context-published" })
    await act({ kind: "tempo", value: 137 }); await drain(); await rendered()
    await act({ kind: "check", mode: "context-published" })
    await act({ kind: "meter", value: 5 }); await act({ kind: "loop-end", value: 2 }); await drain(); await rendered()
    await act({ kind: "check", mode: "context-published" })
    await act({ kind: "loop-end", value: 3 }); await drain(); await rendered()
    await act({ kind: "check", mode: "context-published" })
    await act({ kind: "arm-drop", value: 1, mode: "transport" })
    await act({ kind: "loop" }); await act({ kind: "tempo", value: 100 })
    await act({ kind: "meter", value: 7 }); await drain(); await rendered()
    await act({ kind: "check", mode: "context-published" })
    await act({ kind: "arm-drop", value: 0, mode: "transport" })
    await act({ kind: "check", mode: "drained" })
  } else if (name === "stale-compile-asset-wait" || name === "candidate-page-hold") {
    // The surviving candidate waits on a real deferred native asset (or mapped-page) completion
    // while a newer edit supersedes it; releasing the completion must not promote the stale one.
    const command = name === "candidate-page-hold" ? "asset-page" : "asset"
    await act({ kind: "clip-timing", value: 0 })
    await until(() => fixture.state().compilationIds.length > 0)
    await act({ kind: "resolve-compile", id: fixture.state().compilationIds[0] })
    if (fixture.state().mutation === "no-hold") await drain()
    else await hold(command)
    await act({ kind: "mark", mode: "asset-hold", value: fixture.state().pendingControl?.name === command ? 1 : 0 })
    await act({ kind: "check", mode: "asset-held" })
    // The survivor is declared here, independently of the fixture's clip projection: a 1 s clip at 0.25 s ends at 1.25 s of a 48 kHz session.
    await act({ kind: "mark", mode: "expected-start", value: Math.round(0.25 * 48_000) })
    await act({ kind: "mark", mode: "expected-stop", value: Math.round((0.25 + 1) * 48_000) })
    await act({ kind: "mark", mode: "expected-sources", value: 1 })
    await act({ kind: "clip-timing", value: 0.25, mode: "latest" })
    await drain()
    await rendered()
    await act({ kind: "check", mode: "asset-released" })
    await act({ kind: "check", mode: "drained" })
  } else if (name === "sample-swap" || name === "sample-swap-window") {
    await act({ kind: "clip-timing", value: 0 }); await drain(); await rendered()
    if (name === "sample-swap-window") {
      // The swap lands while a refill window is queued and unanswered by the host.
      await act({ kind: "long-loop" }); await drain()
      await until(() => fixture.state().pendingControl?.name === "window")
    }
    await act({ kind: "mark", mode: "pre-swap", value: name === "sample-swap-window" ? 1 : 0 })
    await act({ kind: "sample-swap" })
    await drain(); await rendered()
    if (name === "sample-swap-window") { await rendered(); await rendered() }
    await act({ kind: "check", mode: "sample-swap" })
    await act({ kind: "check", mode: "drained" })
  } else if (name === "paused-flush") {
    // A successful pause leaves the backend prepared; the flush must settle by progress or proof.
    const firedBefore = fixture.state().timerFires
    await act({ kind: "pause" }); await drain()
    if (!fixture.state().prepared || fixture.state().playing) throw new Error("Paused-flush witness is not prepared and paused")
    await act({ kind: "gain", value: -9 }); await settled()
    await act({ kind: "mark", mode: "timers", value: fixture.state().timerFires - firedBefore })
    await act({ kind: "mark", mode: "expected", value: -9 })
    await act({ kind: "check", mode: "paused-flush" })
  } else if (name === "identity-unchanged") {
    // Preview, then the terminal flush with no publication between them: the same binding,
    // so the unchanged flush dispatches nothing additional.
    const parameters = () => fixture.state().counts.parameters ?? 0
    const step = async (kinds: string[]) => {
      for (const kind of kinds) {
        const next = fixture.enabled().find((entry) => entry.kind === kind)
        if (next) { await act(next); return }
      }
      throw new Error(`No enabled ${kinds.join("/")}`)
    }
    await drain()
    const publishes = fixture.state().counts.publish ?? 0
    await act({ kind: "preview", value: -6 })
    for (let count = 0; count < 40 && (parameters() < 1 || fixture.state().pendingControl || fixture.state().replies.length); count++)
      await step(["raf-tick", "control-wake", "deliver-reply"])
    const dispatched = parameters()
    if (fixture.state().mutation === "dirty-flush") await act({ kind: "preview", value: -9 })
    await act({ kind: "commit" })
    // The flush waits on the compile it needs; until that resolves nothing has been published, so
    // the only way it can dispatch again is by not recognising the preview's binding.
    for (let count = 0; count < 40; count++) await step(["control-wake", "deliver-reply", "raf-tick", "render-block", "deliver-progress"])
    if ((fixture.state().counts.publish ?? 0) !== publishes) throw new Error("A publication landed between preview and flush")
    await act({ kind: "mark", mode: "unchanged-flush", value: parameters() - dispatched })
    await drain()
    await act({ kind: "check", mode: "identity-unchanged" })
  } else if (name === "cancel-other-save") {
    // A gesture is cancelled while the save of an earlier, different edit is still in flight: the
    // stored row the cancel restores is older than that edit, and the edit's own projection change
    // must still reach the processor once its write lands.
    const base = writesStarted()
    await act({ kind: "gain", value: -6 })
    await until(() => writeSince(base)?.state === "open")
    await act({ kind: "preview", value: -13 })
    await act({ kind: "cancel" })
    await completeWrite(base)
    await settled(); await rendered()
    await act({ kind: "mark", mode: "expected", value: -6 })
    await act({ kind: "check", mode: "cancel-other-save" })
  } else if (name === "pause-refused-pending") {
    // The host refuses the panel's flush, so its record is held (design 1.6: a transient refusal waits for an adoption or
    // the domain's end, it is not sent again); the pause then ends the domain it was sent in.
    // The flush is answered without a restore, and the still-desired value reaches native once the host accepts again.
    // (A seek in the hook takes the dispose-and-rebuild path and re-executes the flush; the controller witnesses seek.)
    await act({ kind: "refuse-parameters", value: 2 })
    await act({ kind: "clip-timing", value: 0.25 })
    await act({ kind: "gain", value: -9 })
    await until(() => (fixture.state().counts.parameters ?? 0) >= 1 && !fixture.state().pendingControl
      && fixture.state().waiters.some((waiter) => waiter.name === "flush" && !waiter.settled))
    await act({ kind: "pause" }); await drain()
    await act({ kind: "refuse-parameters", value: 0 })
    await settled()
    await act({ kind: "mark", mode: "expected", value: -9 })
    await act({ kind: "check", mode: "ending-flush" })
  } else if (name === "refused-batch-publication-no-pause") {
    // Reproduce R3 without ending the domain: a refused parameter attempt is held while the candidate publication
    // installs the same desired content. Its accepted receipt must not claim an applied parameter sequence.
    await act({ kind: "refuse-parameters", value: 2 })
    await act({ kind: "gain", value: -9 })
    await until(() => (fixture.state().counts.parameters ?? 0) >= 1 && !fixture.state().pendingControl
      && fixture.state().waiters.some((waiter) => waiter.name === "flush" && !waiter.settled))
    await drain()
    await act({ kind: "refuse-parameters", value: 0 })
    await settled()
    await act({ kind: "check", mode: "refused-batch-publication" })
  } else if (name === "preview-across-pause") {
    // A preview's send is out (its admission reply held) when the pause moves the domain on: the preview is still answered
    // accepted, and Timeline does not take the state-patch fallback for it.
    await act({ kind: "preview", value: -9 })
    await until(() => fixture.state().waiters.some((waiter) => waiter.name === "preview" && !waiter.settled)
      && fixture.state().replies.some((reply) => reply.name === "parameters"))
    const held = fixture.state().replies.find((reply) => reply.name === "parameters")
    await act({ kind: "pause" })
    if (held) await act({ kind: "deliver-reply", id: held.id })
    await drain()
    await act({ kind: "check", mode: "preview-accepted" })
  } else if (name === "processor-timer") {
    // A flush that settles by progress alone; no processor wait may have allocated a timeout on the way.
    await act({ kind: "gain", value: -9 }); await drain(); await rendered()
    await act({ kind: "check", mode: "no-processor-timer" })
  } else if (name === "instrument-urgent") {
    // The panel's instrument gesture through the mounted hook: a preview, a publication, then the
    // terminal flush of the same value, which must join the preview's urgent event rather than resend.
    await act({ kind: "synth-preview", value: 4000 }); await drain()
    await act({ kind: "latency", value: 2048 }); await drain(); await rendered()
    await act({ kind: "synth-flush", value: 4000 }); await drain(); await rendered()
    await act({ kind: "check", mode: "instrument-urgent" })
  } else if (name === "gesture-equal-return" || name === "gesture-cancel-unchanged") {
    // A gesture whose previews return to the value it began from has nothing left to commit or restore,
    // yet it must still end: an external write after it then owns native.
    await act({ kind: "preview", value: -6 }); await drain()
    await act({ kind: "preview", value: 0 }); await drain()
    await act({ kind: name === "gesture-equal-return" ? "commit" : "cancel" }); await drain()
    await act({ kind: "external-adoption", value: -11 }); await settled(); await rendered()
    await act({ kind: "mark", mode: "expected", value: -11 })
    await act({ kind: "check", mode: "gesture-ended" })
  } else if (name === "gesture-multi-field-return" || name === "gesture-multi-field-cancel") {
    // Each preview sends only the fields it changed, so the terminal flush covers more fields than the last
    // dispatch carried. Everything it covers already reached native: ending the gesture sends nothing.
    await act({ kind: "identity-baseline" })
    await act({ kind: "preview", value: -6 }); await drain()
    await act({ kind: "preview", value: -6, mode: "pan" }); await drain()
    await act({ kind: "preview", value: 0 }); await drain()
    await act({ kind: "preview", value: 0, mode: "pan-reset" }); await drain()
    await act({ kind: name === "gesture-multi-field-return" ? "commit" : "cancel" }); await drain()
    await act({ kind: "check", mode: "gesture-closed" })
    await act({ kind: "external-adoption", value: -11 }); await settled(); await rendered()
    await act({ kind: "mark", mode: "expected", value: -11 })
    await act({ kind: "check", mode: "gesture-ended" })
  } else throw new Error(`Unknown A2c scenario ${name}`)
}
