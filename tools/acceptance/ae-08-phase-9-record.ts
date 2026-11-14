import { writeFile } from "node:fs/promises"
import { z } from "zod"
import { readWav } from "./ae08-wav"
import { makeTone, verifyTakeAgainstTone } from "./ae-08-phase-9-devices"
import { waitForUi, type Phase5Context } from "./ae-08-phase-5-fixture"

// The in-app recording flow of the BlackHole rows (record-target-guard, unaffected-input): arm the changed track, Start recording,
// a known tone played into BlackHole, Stop recording, then the take against the tone sample for sample. Every step goes through the
// product's own buttons; the private profile's input is selected by ae-08-phase-9-devices.ts. Never run without BlackHole present:
// the launch fails as a setup failure first.
type RecordContext = Pick<Phase5Context, "evaluate" | "snapshot">

// The tone is played from the start of the burst, so the burst's edit lands inside it. A longer one makes the take a larger page-to-runner
// transfer (about 1.5 MB per second of stereo float32, base64).
export const toneSeconds = 4
// RECORDING_TARGET_LOCKED_REASON (src/lib/track-recording-target.ts). The runner does not import the app's module graph for one string.
export const recordingTargetLockedReason = "Finish recording to delete this track or change its routing."
const changedTrackName = "Changed right"

const clickButton = (label: string) => `(()=>{const b=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(!b)throw new Error(${JSON.stringify(`${label} unavailable`)});b.click();return true})()`
const settled = (label: string, pressed: boolean) => `document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-pressed')===${JSON.stringify(String(pressed))}&&document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-busy')!=='true'`

// Armed before the transport starts: the track is the recording target. Its number is the one its selector shows ("Select track 2: Name"),
// which its arm button repeats.
export const armRecordTarget = async (context: Pick<Phase5Context, "evaluate">) => {
  const number = `(()=>{const label=[...document.querySelectorAll('button[aria-label]')].map(b=>b.getAttribute('aria-label')).find(l=>l?.endsWith(${JSON.stringify(`: ${changedTrackName}`)}));
    const found=/^Select track (\\d+):/.exec(label??'');if(!found)throw new Error('Record target selector missing');return found[1]})()`
  await context.evaluate(`(()=>{const b=document.querySelector('button[aria-label="Arm track '+${number}+' for recording"]');if(!b)throw new Error('Record arm unavailable');b.click();return true})()`)
  await waitForUi(context, "Record arm not pressed", `document.querySelector('button[aria-label="Disarm track '+${number}+' for recording"]')?.getAttribute('aria-pressed')==='true'`)
}

// Starts the transport too. Returns the clips that exist, so the take is the one that is not among them.
export const startRecording = async (context: RecordContext) => {
  const before = new Set((await context.snapshot()).clips.map((clip) => clip.id))
  await context.evaluate(clickButton("Start recording"))
  await waitForUi(context, "Recording did not start", settled("Stop recording", true))
  return before
}

// The take's WAV as the project stores it (OPFS, the asset's file), handed over as base64: browser commands return text.
const takeScript = (projectId: string, assetId: string) => `(async()=>{
  const root=await navigator.storage.getDirectory();
  const assets=await(await root.getDirectoryHandle(${JSON.stringify(projectId)})).getDirectoryHandle('assets');
  const files=[];for await(const [name,entry] of assets.entries())if(entry.kind==='file'&&(name===${JSON.stringify(assetId)}||name.startsWith(${JSON.stringify(`${assetId}.`)})))files.push(entry);
  if(files.length!==1)throw new Error('The recorded asset file is missing or ambiguous');
  const bytes=new Uint8Array(await(await files[0].getFile()).arrayBuffer());
  let binary='';for(let at=0;at<bytes.length;at+=0x8000)binary+=String.fromCharCode(...bytes.subarray(at,at+0x8000));
  return JSON.stringify({base64:btoa(binary)});
})()`

// Stops the recording, waits for the take to land as a clip, reads its file and compares it with the tone.
export const finishRecording = async (context: RecordContext & Pick<Phase5Context, "read">, input: { before: ReadonlySet<string>; file: string }) => {
  await context.evaluate(clickButton("Stop recording"))
  await waitForUi(context, "Recording did not stop", settled("Start recording", false))
  await waitForUi(context, "The take never became a clip", `document.querySelectorAll('[data-timeline-clip]').length>${input.before.size}`)
  const state = await context.snapshot()
  const taken = state.clips.filter((clip) => !input.before.has(clip.id))
  const [take] = taken
  const assetId = take?.source?.assetId
  if (taken.length !== 1 || assetId === undefined) throw new Error(`Expected one new take clip with an asset, found ${taken.length}`)
  const { base64 } = await context.read(takeScript(state.project.id, assetId), z.object({ base64: z.string() }))
  return verifyHandedOverTake(base64, input.file)
}

// The WAV the page handed over, kept as evidence, against the tone: sample for sample from the take's first non-silent frame.
export const verifyHandedOverTake = async (base64: string, file: string) => {
  await writeFile(file, Buffer.from(base64, "base64"))
  return verifyTakeAgainstTone(await readWav(file), makeTone(toneSeconds))
}
