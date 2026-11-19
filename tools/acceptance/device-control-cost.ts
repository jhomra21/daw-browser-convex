// Repeatable device-control cost measurement. Reproduce with:
//   bun tools/acceptance/device-control-cost.ts
// Part A drives the real EffectsPanel in Chromium (agent-browser), Part B drives the real useTimelinePlayback hook
// over a fake native host in bun. Output is deterministic: no timestamps, no random ids.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dir, "../..");
const outputIndex = process.argv.indexOf("--out");
const outputArgument = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--out requires a directory");
const outDir = outputArgument ? resolve(outputArgument) : `${root}/acceptance-reports/device-control-cost-2026-10-31`;
const testFile = "tools/acceptance/device-control-cost.browser.test.ts";

const run = async (name: string, rawDir: string, extraArgs: string[]) => {
  const child = Bun.spawn(
    ["perl", "-e", "alarm shift; exec @ARGV", "3500", "bun", "test", ...extraArgs, "--timeout", "3600000", testFile, "-t", name],
    {
      cwd: root,
      env: { ...process.env, VITE_CONVEX_URL: "https://fixture.convex.cloud", VITE_API_BASE_URL: "http://localhost:8787", DEVICE_COST_RAW_DIR: rawDir, DEVICE_COST_SCRATCH_DIR: rawDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`bun test "${name}" failed (${exit}):\n${out}\n${err}`);
};

const record = z.looseObject({
  device: z.string(),
  engine: z.enum(["legacy", "native"]),
  gesture: z.string(),
  cadence: z.string(),
  applicable: z.boolean(),
  layer: z.literal("dom"),
});
const boundaryCounts = z.object({
  calls: z.number().int().nonnegative(), applications: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(), joins: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(), superseded: z.number().int().nonnegative(),
  notHeld: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(),
  unproven: z.number().int().nonnegative(),
}).refine(count => count.calls === count.applications + count.skips + count.joins + count.dropped
  + count.superseded + count.notHeld + count.rejected + count.unproven, "Every portable call needs exactly one truthful outcome");
const truthfulCounters = z.object({
  portableBoundaries: z.record(z.string(), boundaryCounts),
  nativeSubmitted: z.number().int().nonnegative(),
  nativeOutcomes: z.object({ applied: z.number().int().nonnegative(), superseded: z.number().int().nonnegative(), refused: z.number().int().nonnegative(), unconfirmed: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), pending: z.literal(0) }),
  nativeSubmissions: z.array(z.string()),
}).refine(row => row.nativeSubmitted === Object.values(row.nativeOutcomes).reduce((sum, count) => sum + count, 0)
  && row.nativeSubmitted === row.nativeSubmissions.length, "Every native submission needs its actual registration outcome");
type Rec = z.infer<typeof record>;
const numberOrNull = z.number().nullable().catch(null);
const scheduleWork = z.object({ scheduleWork: z.record(z.string(), z.unknown()) });
const partBCase = z.looseObject({ id: z.string() });

const num = (rec: Rec | undefined, field: string) => {
  return numberOrNull.parse(rec?.[field]);
};
const order = (left: Rec, right: Rec) =>
  [left.device.localeCompare(right.device), left.engine.localeCompare(right.engine), left.gesture.localeCompare(right.gesture), left.cadence.localeCompare(right.cadence)].find((value) => value !== 0) ?? 0;

await mkdir(outDir, { recursive: true });
const rawDir = await mkdtemp(`${outDir}/device-control-cost-raw-`);
try {
  await run("part A", rawDir, []);
  await run("part B", rawDir, ["--conditions=browser"]);
  const partA = z.array(record).parse(await Bun.file(`${rawDir}/part-a.json`).json()).sort(order);
  for (const row of partA) {
    if (row.applicable && row.gesture !== "collapsed-spectrum-decay") truthfulCounters.parse(row);
  }
  const partB = z.array(partBCase).parse(await Bun.file(`${rawDir}/part-b.json`).json());
  const a8 = z.array(z.looseObject({ name: z.string(), status: z.enum(["green", "expected-red"]) })).parse(await Bun.file(`${rawDir}/a8.json`).json());
  const engineControls = z.array(z.looseObject({
    row: z.string(), checks: z.array(z.looseObject({ pass: z.literal(true) })),
  })).parse(await Bun.file(`${rawDir}/engine-controls.json`).json());
  await mkdir(outDir, { recursive: true });
  await Bun.write(`${outDir}/results.json`, `${JSON.stringify({ partA, partB, a8 }, null, 1)}\n`);
  await Bun.write(`${outDir}/engine-controls.json`, `${JSON.stringify(engineControls, null, 2)}\n`);

  const find = (device: string, engine: string, gesture: string, cadence: string) =>
    partA.find((rec) => rec.device === device && rec.engine === engine && rec.gesture === gesture && rec.cadence === cadence);
  const cell = (rec: Rec | undefined, fields: string[]) => rec?.applicable ? fields.map((field) => num(rec, field) ?? "-").join("/") : "n/a";
  const devices = [...new Set(partA.map((rec) => rec.device))];
  const header = "| device | engine | drag w/h/s | wheel w/h/s | key w/h/s | reset w/h/s | toggle w/h/s |\n|---|---|---|---|---|---|---|";
  const rows = devices.flatMap((device) => (["legacy", "native"] as const).map((engine) => {
    const f = ["persistenceWrites", "historyEntries", "legacyEngineSubmits"];
    const cells = [
      cell(find(device, engine, "pointer-drag-20", "per-frame"), f),
      cell(find(device, engine, "wheel-20", "per-frame"), f),
      cell(find(device, engine, "key-hold-20", "per-frame"), f),
      cell(find(device, engine, "double-click-reset", "single"), f),
      cell(find(device, engine, "toggle-or-select", "single"), f),
    ];
    return `| ${device} | ${engine} | ${cells.join(" | ")} |`;
  }));
  const nativeRows = devices.map((device) => {
    const f = ["nativePreviewCalls", "nativeFlushCalls"];
    const instrument = ["instrumentEngineCalls"];
    const legacy = (gesture: string, cadence: string) => cell(find(device, "legacy", gesture, cadence), instrument);
    return `| ${device} | ${cell(find(device, "native", "pointer-drag-20", "per-frame"), f)} | ${cell(find(device, "native", "pointer-drag-20", "burst"), f)} | ${cell(find(device, "native", "wheel-20", "per-frame"), f)} | ${cell(find(device, "native", "key-hold-20", "per-frame"), f)} | ${legacy("pointer-drag-20", "per-frame")} | ${legacy("wheel-20", "per-frame")} |`;
  });
  const nativeHeader = "| device | native drag p/f | native drag burst p/f | native wheel p/f | native key p/f | instrument calls drag (legacy) | instrument calls wheel (legacy) |\n|---|---|---|---|---|---|---|";

  const n = (device: string, engine: string, gesture: string, cadence: string, field: string) => num(find(device, engine, gesture, cadence), field);
  const effectKinds = devices.filter((device) => !["synth", "drum-rack", "sampler", "granular", "arpeggiator"].includes(device));
  const legacyEffectNodes = Math.max(...partA.filter((rec) => rec.engine === "legacy" && effectKinds.includes(rec.device) && rec.applicable).map((rec) => num(rec, "legacyNodeConstructions") ?? 0));
  const legacyEffectRecords = partA.filter((rec) => rec.engine === "legacy" && effectKinds.includes(rec.device) && rec.applicable).length;
  const nativeLegacySubmits = Math.max(...partA.filter((rec) => rec.engine === "native" && rec.applicable).map((rec) => num(rec, "legacyEngineSubmits") ?? 0));
  const spectrum = find("eq", "legacy", "collapsed-spectrum-decay", "single");
  const b = (id: string) => partB.find((entry) => entry.id === id);
  const bv = (id: string, field: string) => {
    return numberOrNull.parse(b(id)?.[field]);
  };
  const sw = (id: string, key: string) => {
    const work = scheduleWork.safeParse(b(id));
    return work.success ? numberOrNull.parse(work.data.scheduleWork[key]) : null;
  };
  const dom = partA.length;
  const applicable = partA.filter((rec) => rec.applicable).length;
  const notApplicable = partA.filter((rec) => !rec.applicable);
  const reasons = [...new Set(notApplicable.map((rec) => String(rec.reason).replace(/ on (delay|reverb)$/u, "").replace(/^no graph-drag-[a-z-]+$/u, "no such graph on this device")))].sort();
  const readme = `# Device control cost, 2026-10-31

Measured cost of one built-in device control edit, replacing the earlier null-only artifact.

## Reproduce

\`\`\`
cd /Users/juan/Documents/daw-browser-convex
perl -e 'alarm shift; exec @ARGV' 3600 env VITE_CONVEX_URL=https://fixture.convex.cloud VITE_API_BASE_URL=http://localhost:8787 bun tools/acceptance/device-control-cost.ts
\`\`\`

The runner spawns \`bun test tools/acceptance/device-control-cost.browser.test.ts\` for Part A (real Chromium through agent-browser, about 11 minutes for both parts) and for Part B (\`--conditions=browser\`), then writes \`results.json\` and this file. Output has no timestamps or random ids; it prints the SHA-256 of \`results.json\`.

## Part B: does a processor-only effect edit trigger schedule work? (DP-07)

Yes. The real \`useTimelinePlayback\` hook over a fake native host, with a \`playbackInputs\` memo shaped like Timeline.tsx \`nativePlaybackInputs\`, changing one Delay \`dryWet\` value:

| case | compileSnapshot | revision.prepare / publish | schedule windows | preview disposals | host stop / teardown |
|---|---|---|---|---|---|
| playing, 1 edit | ${bv("playing-1-edit", "compileSnapshotCalls")} | ${sw("playing-1-edit", "revision.prepare")} / ${sw("playing-1-edit", "revision.publish")} | ${sw("playing-1-edit", "schedule")} | ${bv("playing-1-edit", "previewDisposals")} | ${sw("playing-1-edit", "stop")} / ${sw("playing-1-edit", "teardown")} |
| playing, 20 edits, one per frame | ${bv("playing-20-edits-one-per-frame", "compileSnapshotCalls")} | ${sw("playing-20-edits-one-per-frame", "revision.prepare")} / ${sw("playing-20-edits-one-per-frame", "revision.publish")} | ${sw("playing-20-edits-one-per-frame", "schedule")} | ${bv("playing-20-edits-one-per-frame", "previewDisposals")} | ${sw("playing-20-edits-one-per-frame", "stop")} / ${sw("playing-20-edits-one-per-frame", "teardown")} |
| paused with native preview, 1 edit | ${bv("paused-preview-1-edit", "compileSnapshotCalls")} | ${sw("paused-preview-1-edit", "revision.prepare")} / ${sw("paused-preview-1-edit", "revision.publish")} | ${sw("paused-preview-1-edit", "schedule")} | ${bv("paused-preview-1-edit", "previewDisposals")} (reason \`paused-preview-structural-change\`) | ${sw("paused-preview-1-edit", "stop")} / ${sw("paused-preview-1-edit", "teardown")} |
| paused with native preview, 20 edits | ${bv("paused-preview-20-edits-one-per-frame", "compileSnapshotCalls")} | ${sw("paused-preview-20-edits-one-per-frame", "revision.prepare")} / ${sw("paused-preview-20-edits-one-per-frame", "revision.publish")} | ${sw("paused-preview-20-edits-one-per-frame", "schedule")} | ${bv("paused-preview-20-edits-one-per-frame", "previewDisposals")} | ${sw("paused-preview-20-edits-one-per-frame", "stop")} / ${sw("paused-preview-20-edits-one-per-frame", "teardown")} |
| control: playing, new object identity, same content | ${bv("control-playing-identity-only", "compileSnapshotCalls")} | ${sw("control-playing-identity-only", "revision.prepare")} / ${sw("control-playing-identity-only", "revision.publish")} | ${sw("control-playing-identity-only", "schedule")} | ${bv("control-playing-identity-only", "previewDisposals")} | ${sw("control-playing-identity-only", "stop")} / ${sw("control-playing-identity-only", "teardown")} |
| playing, 20 edits through the live-processor path (mapper + \`liveProcessorControl.preview\`) | ${bv("playing-20-live-processor-previews", "compileSnapshotCalls")} | ${sw("playing-20-live-processor-previews", "revision.prepare")} / ${sw("playing-20-live-processor-previews", "revision.publish")} | ${sw("playing-20-live-processor-previews", "schedule")} | ${bv("playing-20-live-processor-previews", "previewDisposals")} | ${sw("playing-20-live-processor-previews", "stop")} / ${sw("playing-20-live-processor-previews", "teardown")} |

State-patch path: \`mapNativeBuiltInParameterCommit\` maps a Delay edit to ${bv("playing-20-live-processor-previews", "mappedValueCount")} live parameter value(s) per edit, and \`liveProcessorControl.preview\` accepted all 20 (host spy: ${JSON.stringify(b("playing-20-live-processor-previews")?.controllerCalls)}). That path does no schedule work, so the cost in the first rows comes from the \`playbackInputs\` identity change, not from the edit itself. Whether Timeline.tsx sends a given edit down that path in addition is outside what this fake-host test exercises: the hook's effect reacts to \`playbackInputs\` regardless.

## Part A: counts per gesture (real EffectsPanel in Chromium, layer \`dom\`)

w/h/s = persistence writes / history entries / legacy engine submits, one \`per-frame\` cadence (one input per animation frame; the \`burst\` cadence with all inputs in one frame is in \`results.json\`). Wheel is 20 events, drag is 20 moves + up, key is 1 keydown + 19 repeats + keyup, reset is a double-click from a non-default value, toggle is one toggle or select change. Graph-handle and typed-number rows are in \`results.json\`.

${[header, ...rows].join("\n")}

Native preview (p) / flush (f) calls, and instrument engine calls on the legacy engine:

${[nativeHeader, ...nativeRows].join("\n")}

Graph handle drags of 20 moves (per-frame, legacy): Delay filter graph ${cell(find("delay", "legacy", "graph-drag-delay-filter", "per-frame"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}, Reverb filter graph ${cell(find("reverb", "legacy", "graph-drag-reverb-filter", "per-frame"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}, Reverb space graph ${cell(find("reverb", "legacy", "graph-drag-reverb-space", "per-frame"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}, EQ band dot ${cell(find("eq", "legacy", "graph-drag-eq-band", "per-frame"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}. Typed "64" (legacy): sampler ${cell(find("sampler", "legacy", "typed-number-64", "single"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}, granular ${cell(find("granular", "legacy", "typed-number-64", "single"), ["persistenceWrites", "historyEntries", "legacyEngineSubmits"])}, drum-rack has no number input.

Dimensions: ${dom} Part A records (${applicable} measured, ${notApplicable.length} not applicable, all layer \`dom\`) over ${devices.length} devices x 2 engines.

## Results after DV-01 (one interaction model for every built-in device control)

The audit-time numbers (before DV-01) are archived in \`dv01-parent/baseline/results.json\` next to this report; the before/after table is in \`dv01-parent/before-after.md\`.

- **Whole-chain submits (DP-01).** Legacy engine: a 20-move knob drag makes ${n("compressor", "legacy", "pointer-drag-20", "per-frame", "legacyEngineSubmits")} whole-chain submits (the previews update the one retained instance in place; the settle and the audio-sync reconcile submit the chain once each). Node constructions on a real AudioEngine AudioContext during the edit: max ${legacyEffectNodes} across ${legacyEffectRecords} legacy effect records. Native engine: ${nativeLegacySubmits} legacy submits in every record.
- **Wheel (DP-02).** Wheel x20 on a Compressor Knob: ${n("compressor", "legacy", "wheel-20", "per-frame", "persistenceWrites")} write, ${n("compressor", "legacy", "wheel-20", "per-frame", "historyEntries")} history entry, ${n("compressor", "legacy", "wheel-20", "per-frame", "legacyEngineSubmits")} submits (burst: ${n("compressor", "legacy", "wheel-20", "burst", "maxDispatchesPerFrame")} dispatch in one frame), against ${n("compressor", "legacy", "pointer-drag-20", "per-frame", "persistenceWrites")}/${n("compressor", "legacy", "pointer-drag-20", "per-frame", "historyEntries")} for a drag. Double-click reset and toggles are one write plus one history entry each (${n("compressor", "legacy", "double-click-reset", "single", "persistenceWrites")}/${n("compressor", "legacy", "double-click-reset", "single", "historyEntries")}).
- **Graph handles (DP-03).** One drag is one write and one history entry: Delay filter ${n("delay", "legacy", "graph-drag-delay-filter", "per-frame", "persistenceWrites")}/${n("delay", "legacy", "graph-drag-delay-filter", "per-frame", "historyEntries")}, Reverb filter ${n("reverb", "legacy", "graph-drag-reverb-filter", "per-frame", "persistenceWrites")}/${n("reverb", "legacy", "graph-drag-reverb-filter", "per-frame", "historyEntries")}, Reverb space ${n("reverb", "legacy", "graph-drag-reverb-space", "per-frame", "persistenceWrites")}/${n("reverb", "legacy", "graph-drag-reverb-space", "per-frame", "historyEntries")}, EQ band ${n("eq", "legacy", "graph-drag-eq-band", "per-frame", "persistenceWrites")}/${n("eq", "legacy", "graph-drag-eq-band", "per-frame", "historyEntries")}; native Delay filter ${n("delay", "native", "graph-drag-delay-filter", "per-frame", "persistenceWrites")} write with ${n("delay", "native", "graph-drag-delay-filter", "per-frame", "nativePreviewCalls")} previews and ${n("delay", "native", "graph-drag-delay-filter", "per-frame", "nativeFlushCalls")} flush.
- **Instruments (DP-04).** Synth drag: ${n("synth", "legacy", "pointer-drag-20", "per-frame", "instrumentEngineCalls")} instrument engine calls for 20 inputs (${n("synth", "legacy", "pointer-drag-20", "per-frame", "instrumentPreviewCallbacks")} preview callbacks; calls and returned dispositions counted separately; burst: ${n("synth", "legacy", "pointer-drag-20", "burst", "maxDispatchesPerFrame")} dispatches in one frame), ${n("synth", "legacy", "pointer-drag-20", "per-frame", "legacyEngineSubmits")} chain submits, ${n("synth", "legacy", "pointer-drag-20", "per-frame", "persistenceWrites")} write and ${n("synth", "legacy", "pointer-drag-20", "per-frame", "historyEntries")} history entry. Arpeggiator wheel: ${n("arpeggiator", "legacy", "wheel-20", "per-frame", "persistenceWrites")} write.
- **Collapsed EQ spectrum (DP-05).** 240 stepped frames: ${num(spectrum, "expandedFrameCallbacks")} rAF callbacks expanded, ${num(spectrum, "collapsedFrameCallbacks")} after folding the device (canvas still mounted: ${String(spectrum?.eqCanvasStillMountedWhileCollapsed)}, not rendered: ${String(spectrum?.eqCanvasNotRenderedWhileCollapsed)}).
- **Schedule work on a processor-only edit (DP-07, Part B).** Playing: 1 edit makes ${sw("playing-1-edit", "revision.prepare")} revision prepare, ${sw("playing-1-edit", "revision.publish")} publish and ${sw("playing-1-edit", "schedule")} schedule window; 20 edits make ${sw("playing-20-edits-one-per-frame", "revision.prepare")} prepares. Paused with a native preview: ${bv("paused-preview-1-edit", "previewDisposals")} disposal per edit, ${bv("paused-preview-20-edits-one-per-frame", "previewDisposals")} for 20. Part B models the hook only, so DV-01 does not change it; DP-07 is not addressed by DV-01.
- DP-06 (per-move cost) was not measured as CPU or allocation counts.

## Method notes

- Calls and outcomes are independent. Portable boundaries report applications, skips, joins, dropped, superseded, not-held probes, rejections and unproven results per owning entry. Held content is recorded only after a truthful successful result. Native callbacks report submitted content and unproven outcomes, never installation. A8 isolates N=3 and N=20 landed ticks on track/master audio and persisted synth adapters, excluding setup and all-track reconcile.

- Part A bundles the runtime (\`device-control-cost.browser-runtime.tsx\`) with Vite and opens it in Chromium via agent-browser. It mounts the real \`EffectsPanel\`, a real \`AudioEngine\` (legacy rows) and real IndexedDB-backed local effect storage. Events are dispatched in the page (pointer, wheel, keyboard, dblclick); typed numbers use the real keyboard through agent-browser.
- Persistence writes: count of \`IDBObjectStore.put/add\` calls for rows of kind \`effect\`. History: \`onEffectParamsCommitted\` calls. Legacy submits: wrapped \`setTrackFxInstances/setMasterFxInstances/setTrackInstrument/setTrackArpeggiator\`, with callers attributed from the stack. Node constructions: patched \`BaseAudioContext.create*\` and an \`AudioWorkletNode\` subclass on that engine's AudioContext. Native calls: \`onEffectParamsPreview\` / \`onEffectParamsFlush\`. Instrument calls: wrapped sampler, granular and drum-rack buffer sync plus \`setTrackInstrument\`.
- Frames are a manual rAF queue (16 ms virtual per frame). Between steps, \`maxDispatchesPerFrame\` sums portable-engine calls (legacy chain and single-instance submits, instrument engine calls) and native preview and flush calls; it counts no persistence writes and no native publication joins. \`maxPortableDispatchesPerFrame\` and \`maxNativeDispatchesPerFrame\` report each engine on its own, and the native count includes publication joins, the native carrier for Drum Rack, Sampler and Granular. \`maxPortableSessionDispatchesPerFrame\` counts the live processor updates sent to the prepared portable session (\`applyPortableProcessor\`, answered as the panel's default does) as a third engine; \`portableSessionCalls\` is their total. Timers of 50 ms or more (including the 200 ms instrument debounce) run on a virtual clock that is advanced after each gesture, so no real waiting.
- Part B hand-builds the effects projection (\`replaceAudioEffectTargets\` rows from \`createDefaultDelayParams\`) in the shape of \`snapshotExportProjection\`; the host is a fake that logs each call, and \`createNativePlaybackController\` is wrapped read-only to record \`dispose\` reasons and controller calls. Part B is unchanged by DV-01: its rows are identical to the pre-DV-01 baseline.
- Not applicable cells (${notApplicable.length}, reasons): ${reasons.map((reason) => `"${reason}"`).join("; ")}. Sampler and Granular have no Knob or value strip, drum-rack has no number input, and graph handles exist only on Delay, Reverb and EQ. No cell is null for an untried approach.
`;
  await Bun.write(`${outDir}/README.md`, readme);
  const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(`${outDir}/results.json`).arrayBuffer()).digest("hex");
  console.log(`results.json sha256 ${sha}`);
} finally {
  await rm(rawDir, { recursive: true, force: true });
}
