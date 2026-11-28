import path from "node:path"
import { writeFile } from "node:fs/promises"
import { z } from "zod"
import { command } from "../performance/30-track/v3-import-workload"
import { pageDeadlineMs, waitImportedClip, waitNativeFrame, writePhase5Asset, type Phase5Context } from "./ae-08-phase-5-fixture"

// C2 rows: one structural edit (a new track) while the host is alive. The paused row edits between a native pause and
// the resume; the playing row edits mid-playback. Both are judged from host.jsonl (checkPhase8): one spawn, one device
// session, no lifecycle event around the edit, rising revisions. Audio and the edit travel only through product paths.
export const phase8Rows = ["paused-structural", "playing-structural"]
const sampleRate = 48000
const persisted = (id: string) => ({ source: "persisted", id })

// The product's Space shortcut, subscribed first so the native pause cannot land unobserved.
const pauseWithSpace = (context: Phase5Context) => context.read(`new Promise((resolve,reject)=>{
  const session=window.dawDesktop.audioHost.session;
  // Deadline only. Native progress reports the pause.
  const timer=setTimeout(()=>{unsubscribe();reject(new Error("Native pause deadline"))},${pageDeadlineMs});
  const unsubscribe=session.onScheduleProgress(progress=>{
    if(!progress.running){unsubscribe();clearTimeout(timer);resolve(Number(progress.renderedThroughFrame))}
  });
  document.activeElement?.blur();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
})`, z.number().int())

export const runPhase8Fixture = async (context: Phase5Context) => {
  const { out, profile, row, mutate, snapshot, mark } = context
  const runtime = (args: string[]) => command(profile, ["host", ...args])
  const retainedFile = path.join(out, "retained.wav")
  await writePhase5Asset(retainedFile, 180, false)
  await runtime(["import", "--path", retainedFile])
  await waitImportedClip(context, "retained")
  const retained = (await snapshot()).clips.find((clip) => clip.name.includes("retained"))
  if (!retained) throw new Error("Retained fixture import missing")
  await mutate([{ kind: "clip.move", clip: persisted(retained.id), track: persisted(retained.trackId), startSec: 0 },
    { kind: "clip.timing.set", clip: persisted(retained.id), duration: 180 },
    { kind: "project.settings.set", tempoBpm: 120, loopEnabled: false }])
  await context.reload()
  await waitImportedClip(context, "retained")
  await writeFile(path.join(out, "initial-snapshot.json"), JSON.stringify(await snapshot(), null, 2))
  await runtime(["seek", "0"])
  await mark("capture-start")
  await runtime(["play"])
  await waitNativeFrame(context, sampleRate * 2)
  let pausedFrame: number | undefined
  if (row === "paused-structural") pausedFrame = await pauseWithSpace(context)
  const editStart = Date.now()
  await mark("phase8-edit-start", { row })
  await mutate([{ kind: "track.create", name: "Phase 8 structural", trackKind: "audio" }])
  const committed = await snapshot()
  const editEnd = Date.now()
  await mark("phase8-edit-end", { row })
  if (pausedFrame !== undefined) {
    await mark("phase8-resume")
    await runtime(["play"])
  }
  await waitNativeFrame(context, (pausedFrame ?? sampleRate * 2) + sampleRate * 3)
  await mark("capture-end")
  await writeFile(path.join(out, "diagnostics-active.json"), JSON.stringify(await runtime(["diagnostics-v2"]), null, 2))
  await runtime(["stop"])
  await writeFile(path.join(out, "phase8-edits.json"), JSON.stringify({ phase: 8, row, editStart, editEnd,
    pausedFrame: pausedFrame ?? null, committedRevision: committed.project.revision }, null, 2))
}
