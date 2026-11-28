// The AE-08 phase 9 burst rows, declared once. A row alternates its edits between two states; the packaged matrix
// (ae-08-phase-9-matrix.ts) runs it on the desktop app and the portable campaign (ae-08-portable-campaign.ts) runs it on the
// portable engine in Chromium. A row holds the shape of the runs it has: `packaged`, `portable`, or both.

// The class each row declares for ae-08-latency-gates.ts (its latency-class.json).
export type LatencyClass = "plain" | "raise" | "asset" | "vst-insert"

// What an edit that publishes no graph, or not the first one, settles on: the host's applied parameter sequence line, the publication
// that carries a decoded asset (not the track-only one an import makes first), the publication whose schedule windows carry an automation lane ("lane") or none ("lane-free"), the host's editor-open or plug-in fault line, or, for a
// commit the app refuses, the return of the refusal.
// "returned" is for a transport command that is its own observation: the step settles when its edit returns.
export type Settle = "sequence" | "asset" | "lane" | "lane-free" | "refused" | "editor-open" | "state-capture" | "plugin-fault" | "returned"

// How a step is entered when it is not the analyzer's 6 ms crossfade: "ghost" (a removed track's node fades over 5 ms on top of its
// source's 6 ms), "cut" (a restored track or a decoded asset sounds from its publication).
export type Step = { edits: string[]; state: string; entry?: "ghost" | "cut"; settle?: Settle }

// Which check judges a row's bursts: "states" compares the capture with an offline export of each state (the analyzer's judgeBurst),
// "sustained" requires a held live note to stay unbroken, "delete" judges a clip delete on host evidence and its own capture,
// "take" requires the in-app recording's take to equal the tone played into BlackHole,
// "lane" requires the schedule windows an override publishes to carry no automation lane and those of the re-enable to carry it,
// "latency" checks the host's reported latencies against the declared moves and the retained channel against its source shifted by
// the published moves (a pinned lower leaves the shift, so no per-state export can stand for a raise row's later states),
// and no check means the row is only settled and gated on host evidence.
// "held" judges the rows that edit under a note that holds on the edited channel (the held-instrument fixtures): the note never drops out and
// never jumps (a retrigger, a gap's edge or a gain step), and has no reference.
// "editor", "fault" and "trust" judge the VST rows on host evidence (no restart, the editor stays open) and the capture.
// "host-loss", "cancelled-start" and "output-device" judge the rows whose edits drive the transport (PackagedRun.transport) on host evidence and
// the transport state each edit observed; they have no capture to compare.
export type Judge = "states" | "sustained" | "delete" | "latency" | "lane" | "take" | "held" | "editor" | "fault" | "trust" | "host-loss" | "cancelled-start" | "output-device"

export type PackagedRun = {
  // burst: the preset's (or --repetitions) edits. vst-burst: the preset's (or --vst-repetitions) edits. single: one pass of the cycle.
  // launch: one edit per launch, repeated the preset's (or --repetitions) times.
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
  // The state whose offline export stands for every state of a "states" row: the plug-in's own output is not compared (its channel is
  // swapped at each edit), so the export without it stands for every state. The compare delays every export by the live pinned budget.
  reference?: string
  // What every step of the row settles on, unless the step names its own.
  settle?: Settle
  // What a launch of this row needs that no current fixture provides.
  needs?: string
  // "driven": the row's edits start and stop the transport themselves, so the launch does not press Play, waits for no audio and
  // leaves the host as the row left it.
  transport?: "driven"
  // A calibration row measures a constant of the latency gates (AE08-ASSET-LOAD-PLAN.md section 1). It runs only when named or in the
  // extended preset, never in the certifying one.
  calibration?: true
  // A row of the extended preset only: the certifying preset leaves it out.
  tier?: "extended"
  // The repetitions this row takes in a preset when no flag names them; a preset leaves unset what the row's repeat kind defaults.
  repetitions?: { cert?: number; extended?: number }
}

// `cert` is the certifying matrix (70 minutes), `extended` the overnight one.
export type Preset = "cert" | "extended"

// `--matrix` names a preset; `full` is the old name of the extended one.
export const presetNamed = new Map<string, Preset>([["cert", "cert"], ["extended", "extended"], ["full", "extended"]])

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
  // The limiter's path delay follows its lookahead (limiterLatencyFrames in timing.ts), so a lookahead change replaces
  // the processor state (the second list of mapLimiter in native-built-in-parameter-mapper.ts), not a live parameter write.
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
  // An offline export applies a lane the override has turned off in the player, so no export stands for the overridden state. The drag
  // settles on the follow publication whose schedule windows carry no lane, the re-enable on the publication whose windows carry it again
  // (neither is a graph-less parameter write, and the re-enable emits no sequence).
  { name: "manual-automation-override", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:lane-state", start: "lane-armed", judge: "lane",
    cycle: [{ edits: ["knob-drag"], state: "lane-overridden", settle: "lane-free" }, { edits: ["lane-rearm"], state: "lane-armed", settle: "lane" }] } },
  { name: "sustained-live-midi", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:live-midi", start: "base", judge: "sustained",
    device: "iac-midi", prepare: ["midi-select-iac", "midi-hold"],
    cycle: [{ edits: ["silent-track-create"], state: "extra-track" }, { edits: ["silent-track-delete"], state: "base" }] } },
  // The recording rows (ae-08-phase-9-record.ts): the commit that deletes the armed target is refused and publishes nothing, so the step
  // settles when the refusal returns; the unrelated edit publishes as usual. Both judge the take against the tone sample for sample.
  { name: "record-target-guard", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:raw-tempo", start: "armed", device: "blackhole",
    prepare: recording, judge: "take", settle: "refused", cycle: [{ edits: ["target-delete-refused"], state: "armed" }] } },
  { name: "unaffected-input", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:raw-tempo", start: "recording", device: "blackhole",
    prepare: recording, judge: "take", cycle: [{ edits: ["silent-track-create"], state: "recording" }] } },
  // Its edits are those of vst-remove-undo in the other order and the insert publications carry the same class, so only the extended preset runs it.
  { name: "vst-insert", latencyClass: "vst-insert", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-absent", prepare: testPlugin, tier: "extended",
    cycle: [{ edits: ["vst-insert"], state: "vst-present" }, { edits: ["vst-remove"], state: "vst-absent" }] } },
  // Removing an external plug-in is not an undo history entry (EffectsPanel removeExternalProcessor), so the plug-in comes back by a new insert.
  // The test plug-in is a pass-through at its default Latency, so both states sound as the state without it (the reference).
  // 40 steps give the 20 inserts the frozen vst-insert limit was sampled on.
  { name: "vst-remove-undo", latencyClass: "plain", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin, judge: "states", reference: "vst-absent",
    repetitions: { cert: 40 }, cycle: [{ edits: ["vst-remove"], state: "vst-absent" }, { edits: ["vst-insert"], state: "vst-present" }] } },
  { name: "vst-latency-switch", latencyClass: "raise", packaged: { repeat: "vst-burst", periodSec: null, fixture: "phase5:raw-tempo", start: "latency-low", prepare: insertedTestPlugin, judge: "latency",
    cycle: [{ edits: ["latency-high"], state: "latency-high" }, { edits: ["latency-low"], state: "latency-low" }] } },
  // Opening the editor publishes no graph: it settles on the host's vst-editor-state line. The edit after it must publish in place with the editor still open.
  { name: "open-editor", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin, judge: "editor",
    cycle: [{ edits: ["editor-open"], state: "editor-open", settle: "editor-open" }, { edits: ["latency-high"], state: "latency-high" }] } },
  // The plug-in is crashed through its Fault parameter: the host isolates it, the device reports it, and the unrelated source keeps sounding.
  { name: "faulty-plugin", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-present", prepare: insertedTestPlugin, judge: "fault",
    cycle: [{ edits: ["vst-fault"], state: "vst-failed", settle: "plugin-fault" }] } },
  // The bundle stays untrusted: its browser entry is refused with the trust reason and nothing restarts.
  { name: "trust-negative", latencyClass: "vst-insert", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "vst-absent", prepare: ["vst-untrusted-browser"], judge: "trust",
    cycle: [{ edits: ["untrusted-insert"], state: "vst-rejected", settle: "refused" }] } },
  // The phase 6 and 6i rows with a note held on the right channel (ae-08-phase-5-fixture.ts held-* rows, Changed right muted): the edit lands on an
  // unrelated track (instrument insert and remove, effect reorder) or on the instrument that holds the note (polyphony down under a chord, a zone
  // or pad gain, the grain density, a sample swapped for a 1 % louder copy), and the note must go on without a gap or a jump.
  { name: "instrument-insert", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-insert", start: "instrument-present", judge: "held",
    cycle: [{ edits: ["instrument-remove"], state: "instrument-absent" }, { edits: ["instrument-insert"], state: "instrument-present" }] } },
  { name: "effect-reorder", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-reorder", start: "utility-first", judge: "held",
    cycle: [{ edits: ["effects-reverse"], state: "saturator-first" }, { edits: ["effects-restore"], state: "utility-first" }] } },
  { name: "polyphony-down-held-chord", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-chord", start: "polyphony-16", judge: "held",
    cycle: [{ edits: ["polyphony-2"], state: "polyphony-2" }, { edits: ["polyphony-16"], state: "polyphony-16" }] } },
  // The copy is installed by the first swap (its publication follows an asset-install and its page writes); the swap back and every
  // later swap find both samples resident and log no asset line, so no step waits for one: each settles on its first publication.
  { name: "asset-swap-held-note", latencyClass: "asset", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-swap", start: "asset-changed", judge: "held",
    cycle: [{ edits: ["sampler-swap-asset"], state: "asset-copy" }, { edits: ["sampler-swap-back"], state: "asset-changed" }] } },
  // The size calibration of the asset gate: 27 and 100 MiB swap to five never-loaded copies and back (10 edits), 300 MiB swaps to one copy
  // and back twice (4 edits; the sample is above the resident cap, so every swap uploads).
  ...[["27", 5, 10], ["100", 5, 10], ["300", 1, 4]].map(([mib, copies, edits]): BurstRow => ({ name: `asset-swap-calibration-${mib}`, latencyClass: "asset",
    packaged: { repeat: "burst", periodSec: null, fixture: `phase5:held-swap:${mib}:${copies}`, start: "asset-changed", judge: "held", calibration: true,
      repetitions: { cert: Number(edits), extended: Number(edits) }, cycle: Array.from({ length: Number(copies) }, (_, index) => [{ edits: [`sampler-swap-asset-${index + 1}`], state: `asset-copy-${index + 1}` },
        { edits: ["sampler-swap-back"], state: "asset-changed" }]).flat() } })),
  { name: "held-note-sampler", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-sampler", start: "gain-full", judge: "held",
    cycle: [{ edits: ["sampler-gain-half"], state: "gain-half" }, { edits: ["sampler-gain-full"], state: "gain-full" }] } },
  { name: "held-note-drum-rack", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-drum-rack", start: "gain-full", judge: "held",
    cycle: [{ edits: ["drum-rack-gain-half"], state: "gain-half" }, { edits: ["drum-rack-gain-full"], state: "gain-full" }] } },
  { name: "held-note-granular", latencyClass: "plain", packaged: { repeat: "burst", periodSec: null, fixture: "phase5:held-granular", start: "density-40", judge: "held",
    cycle: [{ edits: ["granular-density-48"], state: "density-48" }, { edits: ["granular-density-40"], state: "density-40" }] } },
  // Phase 7, the sibling of record-target-guard: the commit that reroutes the armed target is refused with the lock's reason and publishes nothing.
  { name: "record-target-reroute", latencyClass: "plain", packaged: { repeat: "launch", periodSec: null, fixture: "phase5:raw-tempo", start: "armed", device: "blackhole",
    prepare: recording, judge: "take", settle: "refused", cycle: [{ edits: ["target-reroute-refused"], state: "armed" }] } },
  // Ruling 3 a: the audio host is killed by pid while a Play of a project with the test plug-in (it needs native) is pending. The transport stays
  // stopped, the app reports native unavailable, and no session is started.
  { name: "host-failure-during-play", latencyClass: "plain", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "stopped", prepare: insertedTestPlugin,
    judge: "host-loss", transport: "driven", settle: "returned", cycle: [{ edits: ["play-kill-host"], state: "stopped" }] } },
  // Ruling 3 b: a Pause and a Stop issued over a Play whose start has not landed cancel it without a stop, teardown, begin or configure, leave the
  // transport paused (stopped at 0 after a Stop), and the next Play resumes the same session.
  { name: "pause-stop-during-play-start", latencyClass: "plain", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "paused",
    judge: "cancelled-start", transport: "driven", settle: "returned",
    cycle: [{ edits: ["session-pause"], state: "paused" }, { edits: ["play-then-pause"], state: "paused" }, { edits: ["play-resume"], state: "playing" },
      { edits: ["session-pause"], state: "paused" }, { edits: ["play-then-stop"], state: "stopped" }, { edits: ["play-resume"], state: "playing" }] } },
  // The saved native output changes in Audio settings while playing, while paused, and during a take (BlackHole is the other output). The steps
  // mark the host's lifecycle lines they saw (ae-08-phase-9-output-device.ts) and the judge reads what each step must have caused from them.
  { name: "output-device-switch", latencyClass: "plain", packaged: { repeat: "single", periodSec: null, fixture: "phase5:raw-tempo", start: "stopped", device: "blackhole",
    prepare: ["record-select-input"], transport: "driven", settle: "returned", judge: "output-device",
    cycle: ["out-play", "out-to-blackhole-playing", "out-to-speakers-playing", "out-reselect-speakers-playing", "out-pause", "out-to-blackhole-paused",
      "out-play-after-paused-switch", "out-pause-again", "out-to-speakers-paused", "out-play-back-on-speakers", "out-to-missing-playing", "out-play-with-missing",
      "out-restore-speakers", "out-play-after-restore", "out-recording-keeps-devices"].map((edit) => ({ edits: [edit], state: "stopped" })) } },
  // The same switch with the test plug-in inserted and a sampler holding a note (the held-sampler fixture mutes Changed right, so the sampler is the
  // only source): the rebuild must bring both back.
  { name: "output-device-switch-instruments", latencyClass: "plain", packaged: { repeat: "single", periodSec: null, fixture: "phase5:held-sampler", start: "stopped", device: "blackhole",
    prepare: insertedTestPlugin, transport: "driven", settle: "returned", judge: "output-device",
    cycle: ["out-play", "out-pause", "out-to-blackhole-paused", "out-play-after-paused-switch", "out-to-speakers-playing"].map((edit) => ({ edits: [edit], state: "stopped" })) } },
  // Portable-only rows: the portable engine has no packaged counterpart for them.
  { name: "mixer-gain", latencyClass: "plain", portable: { from: "base", to: "gain", latency: false } },
  { name: "clip-note", latencyClass: "plain", portable: { from: "base", to: "note", latency: false } },
  { name: "effect-insert-remove", latencyClass: "plain", portable: { from: "base", to: "effect", latency: false } },
]

const packagedRows: Row[] = burstRows.flatMap(({ name, latencyClass, packaged }) => packaged ? [{ name, latencyClass, ...packaged }] : [])

export const phase9Presets = {
  cert: packagedRows.filter((row) => row.tier === undefined && row.calibration === undefined),
  extended: packagedRows,
} satisfies Record<Preset, Row[]>

export const phase9Rows = packagedRows.map((row) => row.name)
export const portableCampaignRows: PortableCampaignRow[] = burstRows.flatMap(({ name, latencyClass, portable }) => portable ? [{ row: name, class: latencyClass, ...portable }] : [])
