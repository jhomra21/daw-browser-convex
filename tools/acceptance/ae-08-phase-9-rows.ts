// The AE-08 phase 9 burst rows, declared once. A row alternates its edits between two states; the packaged matrix
// (ae-08-phase-9-matrix.ts) runs it on the desktop app and the portable campaign (ae-08-portable-campaign.ts) runs it on the
// portable engine in Chromium. A row holds the shape of the runs it has: `packaged`, `portable`, or both.

// The class each row declares for ae-08-latency-gates.ts (its latency-class.json).
export type LatencyClass = "plain" | "raise" | "asset" | "vst-insert"
// What an edit that publishes no graph, or not the first one, settles on: the host's applied parameter sequence line, the publication
// that carries a decoded asset (not the track-only one an import makes first), the host's editor-open or plug-in fault line, or, for a
// commit the app refuses, the return of the refusal.
export type Settle = "sequence" | "asset" | "refused" | "editor-open" | "plugin-fault"
// How a step is entered when it is not the analyzer's 6 ms crossfade: "ghost" (a removed track's node fades over 5 ms on top of its
// source's 6 ms), "cut" (a restored track or a decoded asset sounds from its publication).
export type Step = { edits: string[]; state: string; entry?: "ghost" | "cut"; settle?: Settle }
// Which check judges a row's bursts: "states" compares the capture with an offline export of each state (the analyzer's judgeBurst),
// "sustained" requires a held live note to stay unbroken, "delete" judges a clip delete on host evidence and its own capture,
// "take" requires the in-app recording's take to equal the tone played into BlackHole,
// "latency" checks the host's reported latencies against the declared moves and the retained channel against its source shifted by
// the published moves (a pinned lower leaves the shift, so no per-state export can stand for a raise row's later states),
// and no check means the row is only settled and gated on host evidence.
// "editor", "fault" and "trust" judge the VST rows on host evidence (no restart, the editor stays open) and the capture.
export type Judge = "states" | "sustained" | "delete" | "latency" | "take" | "editor" | "fault" | "trust"
export type PackagedRun = {
  // burst: --repetitions edits. vst-burst: --vst-repetitions edits. single: one pass of the cycle. launch: one edit per launch, repeated --repetitions times.
  repeat: "burst" | "vst-burst" | "single" | "launch"
  // Loop-periodic rows (output in a state repeats every periodSec) get short per-state references; others get one full-length one.
  periodSec: number | null
  // The existing runner fixture whose setup builds the start state, or null when no current fixture can.
  fixture: string | null
  start: string
  cycle: Step[]
  // Edits performed after the setup and before the capture starts (trust, an inserted plug-in, a selected device).
  prepare?: string[]
  // A hardware device the row needs. A launch checks that it is present before the app starts.
  device?: "iac-midi" | "blackhole"
  judge?: Judge
  // What every step of the row settles on, unless the step names its own.
  settle?: Settle
  // What a launch of this row needs that no current fixture provides.
  needs?: string
}
export type PortableRun = { from: string; to: string; latency: boolean }
type BurstRow = { name: string; latencyClass: LatencyClass; packaged?: PackagedRun; portable?: PortableRun }
export type Row = PackagedRun & { name: string; latencyClass: LatencyClass }
export type PortableCampaignRow = PortableRun & { row: string; class: LatencyClass }

// The effect-state devices with the Spectral on the master path, so a declared latency move reaches it.
const raiseState = "phase5:raise-state"
const testPlugin = ["vst-trust"]
const insertedTestPlugin = ["vst-trust", "vst-insert"]
const recording = ["record-select-input", "record-arm"]

export const burstRows: BurstRow[] = [
  { name: "attach-remove-long-latency", latencyClass: "raise", packaged: { repeat: "burst", periodSec: null, fixture: raiseState, start: "spectral-512", judge: "latency",
    cycle: [{ edits: ["spectral-remove"], state: "spectral-absent" }, { edits: ["spectral-attach"], state: "spectral-512" }] } },
  { name: "fft-transition", latencyClass: "raise",
    packaged: { repeat: "burst", periodSec: null, fixture: raiseState, start: "spectral-512", judge: "latency",
      cycle: [{ edits: ["fft-4096"], state: "spectral-4096" }, { edits: ["fft-512"], state: "spectral-512" }] },
    portable: { from: "spec512", to: "spec1024", latency: true } },
  { name: "raise-lower-burst", latencyClass: "raise", packaged: { repeat: "burst", periodSec: null, fixture: raiseState, start: "spectral-512", judge: "latency",
    cycle: [{ edits: ["fft-4096", "fft-512"], state: "spectral-512" }] } },
  // The limiter's path delay stays fixed at 5 ms (audio_core.cpp:3196), so a lookahead change is a live parameter write
  // (limiter.lookaheadMs in native-built-in-parameter-mapper.ts) and publishes no graph.
  { name: "lookahead-transition", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:limiter-state", start: "limiter-lookahead-5",
    judge: "states", settle: "sequence",
    cycle: [{ edits: ["lookahead-1ms"], state: "limiter-lookahead-1" }, { edits: ["lookahead-5ms"], state: "limiter-lookahead-5" }] } },
  { name: "undo-redo-burst", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:remove-readd-track", start: "restored", judge: "states",
    cycle: [{ edits: ["track-delete"], state: "deleted", entry: "ghost" }, { edits: ["undo"], state: "restored", entry: "cut", settle: "asset" },
      { edits: ["redo"], state: "deleted", entry: "ghost" }, { edits: ["undo"], state: "restored", entry: "cut", settle: "asset" }] } },
  // Ruling 3: one delete per launch, judged on host evidence and the capture itself, never against a reference.
  { name: "delete-while-starting", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:delete-clip", start: "clip-present", judge: "delete",
    cycle: [{ edits: ["clip-delete"], state: "clip-deleted" }] } },
  { name: "paged-playback", latencyClass: "asset", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:add-paged-asset", start: "paged-asset-absent", judge: "states",
    cycle: [{ edits: ["asset-import"], state: "paged-asset-present", entry: "cut", settle: "asset" }, { edits: ["asset-clip-delete"], state: "paged-asset-absent" }] } },
  // The states of the next two rows sound alike, so the analyzer's fade model compares them exactly.
  { name: "held-note-unrelated-edit", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-note", start: "base", judge: "states",
    cycle: [{ edits: ["silent-track-create"], state: "extra-track" }, { edits: ["silent-track-delete"], state: "base" }] } },
  { name: "tempo-burst", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:raw-tempo", start: "tempo-120", judge: "states",
    cycle: [{ edits: ["tempo-137"], state: "tempo-137" }, { edits: ["tempo-120"], state: "tempo-120" }] } },
  // No judge: an offline export applies a lane the override has turned off in the player, so no export stands for the overridden state.
  // The row is settled on the applied parameter sequence and gated on host evidence.
  { name: "manual-automation-override", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:lane-state", start: "lane-armed",
    settle: "sequence",
    cycle: [{ edits: ["knob-drag"], state: "lane-overridden" }, { edits: ["lane-rearm"], state: "lane-armed" }] } },
  { name: "sustained-live-midi", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:live-midi", start: "base", judge: "sustained",
    device: "iac-midi", prepare: ["midi-select-iac", "midi-hold"],
    cycle: [{ edits: ["silent-track-create"], state: "extra-track" }, { edits: ["silent-track-delete"], state: "base" }] } },
  // The recording rows (ae-08-phase-9-record.ts): the commit that deletes the armed target is refused and publishes nothing, so the step
  // settles when the refusal returns; the unrelated edit publishes as usual. Both judge the take against the tone sample for sample.
  { name: "record-target-guard", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:raw-tempo", start: "armed", device: "blackhole",
    prepare: recording, judge: "take", settle: "refused", cycle: [{ edits: ["target-delete-refused"], state: "armed" }] } },
  { name: "unaffected-input", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:raw-tempo", start: "recording", device: "blackhole",
    prepare: recording, judge: "take", cycle: [{ edits: ["silent-track-create"], state: "recording" }] } },
  { name: "vst-insert", latencyClass: "vst-insert", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-absent", prepare: testPlugin,
    cycle: [{ edits: ["vst-insert"], state: "vst-present" }, { edits: ["vst-remove"], state: "vst-absent" }] } },
  // Removing an external plug-in is not an undo history entry (EffectsPanel removeExternalProcessor), so the plug-in comes back by a new insert.
  { name: "vst-remove-undo", latencyClass: "plain", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin,
    cycle: [{ edits: ["vst-remove"], state: "vst-absent" }, { edits: ["vst-insert"], state: "vst-present" }] } },
  { name: "vst-latency-switch", latencyClass: "raise", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "latency-low", prepare: insertedTestPlugin,
    cycle: [{ edits: ["latency-high"], state: "latency-high" }, { edits: ["latency-low"], state: "latency-low" }] } },
  // Opening the editor publishes no graph: it settles on the host's vst-editor-state line. The edit after it must publish in place with the editor still open.
  { name: "open-editor", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin, judge: "editor",
    cycle: [{ edits: ["editor-open"], state: "editor-open", settle: "editor-open" }, { edits: ["latency-high"], state: "latency-high" }] } },
  // The plug-in is crashed through its Fault parameter: the host isolates it, the device reports it, and the unrelated source keeps sounding.
  { name: "faulty-plugin", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin, judge: "fault",
    cycle: [{ edits: ["vst-fault"], state: "vst-failed", settle: "plugin-fault" }] } },
  // The bundle stays untrusted: its browser entry is refused with the trust reason and nothing restarts.
  { name: "trust-negative", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-absent", judge: "trust",
    cycle: [{ edits: ["untrusted-insert"], state: "vst-rejected", settle: "refused" }] } },
  // Portable-only rows: the portable engine has no packaged counterpart for them.
  { name: "mixer-gain", latencyClass: "plain", portable: { from: "base", to: "gain", latency: false } },
  { name: "clip-note", latencyClass: "plain", portable: { from: "base", to: "note", latency: false } },
  { name: "effect-insert-remove", latencyClass: "plain", portable: { from: "base", to: "effect", latency: false } },
]

export const phase9Matrix: Row[] = burstRows.flatMap(({ name, latencyClass, packaged }) => packaged ? [{ name, latencyClass, ...packaged }] : [])
export const phase9Rows = phase9Matrix.map((row) => row.name)
export const portableCampaignRows: PortableCampaignRow[] = burstRows.flatMap(({ name, latencyClass, portable }) => portable ? [{ row: name, class: latencyClass, ...portable }] : [])
