import { watch } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { nativeEvents } from "./ae-08-phase-9-matrix"
import { waitForUi, type Phase5Context } from "./ae-08-phase-5-fixture"
import { blackhole, playToneIntoBlackhole } from "./ae-08-phase-9-devices"
import { armRecordTarget, finishRecording, startRecording, toneSeconds } from "./ae-08-phase-9-record"

// The saved native output device changed in Audio settings while the transport plays, is paused, or records. Every step goes through the
// product's own Audio settings select and marks the host's lifecycle lines it saw (`device-switch-observed`); the row has no judge, the
// evidence is read per step: a changed device rebuilds the session in the same host, an unchanged one does not, and a take keeps its devices.
// While the transport plays, a step also captures BlackHole's input for captureSeconds (ffmpeg's own -t, no timer here) and marks its levels:
// signal there means the session sounds on BlackHole, and silence that it does not.
const lifecycleEvents = ["device-session", "device-stop", "device-configure", "device-start-request", "structural-rebuild", "host-spawn", "host-exit",
  "worker-spawn", "worker-ready", "asset-install"]
const switchDeadlineMs = 6_000
const captureSeconds = 2
const missingOutputId = "coreaudio:ae08-missing-output"
const unavailableLabel = "Saved output (unavailable)"

const blackholeLevels = async () => {
  const child = Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", "-f", "avfoundation", "-i", `:${blackhole}`, "-t", String(captureSeconds), "-af", "volumedetect", "-f", "null", "-"],
    { stdout: "ignore", stderr: "pipe" })
  const [log, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  const level = (name: string) => new RegExp(`${name}: (\\S+) dB`).exec(log)?.[1] ?? `no ${name} (ffmpeg exit ${code})`
  return { blackholeMeanDb: level("mean_volume"), blackholeMaxDb: level("max_volume") }
}

const countsOf = async (out: string) => {
  const events = await nativeEvents(out)
  return Object.fromEntries(lifecycleEvents.map((name) => [name, events.filter((event) => event.event === name).length]))
}

// The main process appends host.jsonl as it runs, so this waits on file changes; the deadline only reports a missing line.
const awaitMore = (out: string, event: string, than: number) => new Promise<void>((resolve, reject) => {
  const watcher = watch(out, () => void check())
  const timer = setTimeout(() => finish(() => reject(new Error(`no new ${event} line within ${switchDeadlineMs} ms of the device change`))), switchDeadlineMs)
  // (the deadline is the timeout of a wait on file changes, as in awaitPublicationComplete)
  let done = false
  const finish = (settle: () => void) => {
    if (done) return
    done = true
    watcher.close(); clearTimeout(timer)
    settle()
  }
  const check = async () => {
    try { if ((await countsOf(out))[event] > than) finish(resolve) } catch (error) { finish(() => reject(error)) }
  }
  void check()
})

const outputDevicesScript = `(async()=>{
  const reply=await window.dawDesktop.audioHost.listDevices();
  if(!reply.ok)throw new Error("The native host listed no devices");
  return JSON.stringify(reply.devices.filter(entry=>entry.available&&entry.outputChannelCount>0).map(({name,deviceId})=>({name,deviceId})));
})()`
const outputDevices = z.array(z.object({ name: z.string(), deviceId: z.string() }))
const savedOutputScript = `(()=>JSON.stringify(JSON.parse(localStorage.getItem("daw-browser.app-preferences.v1")??"{}").audio?.nativeOutputDeviceId??""))()`
const dashboard = (view: "audio" | null) => `(()=>{const url=new URL(location.href);${view ? `url.searchParams.set("dashboard","${view}")` : `url.searchParams.delete("dashboard")`};
  history.pushState(null,"",url.toString());window.dispatchEvent(new PopStateEvent("popstate"));return true})()`
const press = (label: string) => `(()=>{const b=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(!b)throw new Error(${JSON.stringify(`${label} unavailable`)});b.click();return true})()`
const transportButton = (label: "Play" | "Pause") => `document.querySelector('button[aria-label="${label}"]')!==null&&document.querySelector('button[aria-label="${label}"]')?.getAttribute('aria-busy')!=='true'`

type Context = Pick<Phase5Context, "evaluate" | "read" | "mark" | "snapshot">
export const createOutputDeviceSteps = (input: { context: Context; out: string; transportStatus: () => Promise<{ state: string; playheadSec: number }> }) => {
  const { context, out, transportStatus } = input
  const observe = async (step: string, before: Record<string, number>, extra: Record<string, string | number | boolean> = {}) => {
    const status = await transportStatus()
    const after = JSON.stringify(await countsOf(out))
    // A refused plug-in state read names its reason in the host's `cause`; the marks keep them in order, over the whole row.
    const stateReadRefusals = JSON.stringify((await nativeEvents(out)).filter((event) => event.event === "vst-state-get-refused").map((event) => event.cause))
    const saved = await context.read(savedOutputScript, z.string())
    await context.mark("device-switch-observed", { step, before: JSON.stringify(before), after, stateReadRefusals, state: status.state, playheadSec: status.playheadSec, saved,
      blackhole: status.state === "playing" ? JSON.stringify(await blackholeLevels()) : "not captured",
      consoleErrors: JSON.stringify(await context.read(`JSON.stringify(window.ae08ConsoleErrors??[])`, z.array(z.string()))),
      notices: JSON.stringify(await context.read(`JSON.stringify([...document.querySelectorAll('[role="status"],[role="alert"],[role="dialog"],[data-sonner-toast]')].map(node=>node.textContent))`, z.array(z.string().nullable()))),
      ...extra })
  }
  // The value goes through the product's own select handler; a saved id the host does not list gets an option for the select to take.
  const selectSaved = async (select: string, value: string) => {
    await context.evaluate(dashboard("audio"))
    await waitForUi(context, `The Audio settings ${select} select never rendered`, `document.querySelector('#${select}')!==null`)
    await context.evaluate(`(()=>{const select=document.querySelector('#${select}');
      if(![...select.options].some(option=>option.value===${JSON.stringify(value)}))select.append(Object.assign(document.createElement('option'),{value:${JSON.stringify(value)}}));
      select.value=${JSON.stringify(value)};select.dispatchEvent(new Event("change",{bubbles:true}));return true})()`)
  }
  const choose = async (name: string) => {
    const devices = await context.read(outputDevicesScript, outputDevices)
    const device = devices.find((entry) => entry.name === name) ?? devices.find((entry) => name === "speakers" && entry.name !== blackhole)
    if (!device) throw new Error(`${name} is not a native audio output of the private profile`)
    await selectSaved("audio-native-playback-output", device.deviceId)
    await context.evaluate(dashboard(null))
    return device
  }
  const reportedUnavailable = (text: string) => context.read(`JSON.stringify(document.body.innerText.includes(${JSON.stringify(text)}))`, z.boolean())
  // A saved output the host no longer lists (an unplugged device): the select keeps it as "Saved output (unavailable)", the rebuild is refused with
  // that notice and nothing starts on another device.
  const switchToMissing = async () => {
    const before = await countsOf(out)
    await selectSaved("audio-native-playback-output", missingOutputId)
    await waitForUi(context, "The select never showed the saved output as unavailable", `[...document.querySelectorAll('#audio-native-playback-output option')].some(option=>option.textContent===${JSON.stringify(unavailableLabel)})`)
    await context.evaluate(dashboard(null))
    const stopped = await awaitMore(out, "device-stop", before["device-stop"]).then(() => true, () => false)
    await observe("switch-to-missing", before, { stopped, noticeShown: await reportedUnavailable(unavailableLabel) })
  }
  const playWithMissing = async () => {
    const before = await countsOf(out)
    await context.evaluate(press("Play"))
    const refused = await awaitMore(out, "device-start-request", before["device-start-request"]).then(() => false, () => true)
    await observe("play-with-missing-output", before, { refused, noticeShown: await reportedUnavailable(unavailableLabel) })
  }
  // The product reports a refused move with console.error only when it is not a notice, so the page's errors are kept for the step marks.
  const recordConsoleErrors = `(()=>{if(window.ae08ConsoleErrors)return true;window.ae08ConsoleErrors=[];const original=console.error.bind(console);
    console.error=(...args)=>{window.ae08ConsoleErrors.push(args.map(arg=>arg instanceof Error?arg.stack??arg.message:String(arg)).join(' ').slice(0,600));original(...args)};return true})()`
  const switchTo = (name: string, rebuilds: "session" | "configure" | "none") => async () => {
    await context.evaluate(recordConsoleErrors)
    const before = await countsOf(out)
    const device = await choose(name)
    const event = rebuilds === "session" ? "device-session" : "device-configure"
    // A missing line is evidence of a switch that did not move the session, not a setup failure: it is marked and the steps go on.
    const moved = rebuilds === "none" ? true : await awaitMore(out, event, before[event]).then(() => true, () => false)
    await observe(`switch-to-${name}`, before, { device: device.name, deviceId: device.deviceId, expected: rebuilds, moved })
  }
  const play = async () => {
    const before = await countsOf(out)
    await context.evaluate(press("Play"))
    await waitForUi(context, "Play never started", transportButton("Pause"))
    await observe("play", before)
  }
  const pause = async () => {
    const before = await countsOf(out)
    await context.evaluate(press("Pause"))
    await waitForUi(context, "Pause never took", transportButton("Play"))
    await observe("pause", before)
  }
  // A take binds its devices at its start: an output change during it is only noticed, and the playback session moves after the take.
  // The first take records the BlackHole tone and must keep BlackHole as its input although the saved input and output change during it; the
  // output moves when the take ends. The second take then reads the new saved input (the system default), so it does not hear the tone.
  const recordingKeepsDevices = async () => {
    await context.evaluate(press("Stop"))
    await armRecordTarget(context)
    const before = await countsOf(out)
    const clips = await startRecording(context)
    const started = await countsOf(out)
    const tone = playToneIntoBlackhole(path.join(out, "tone-take-1.wav"), toneSeconds)
    await choose(blackhole)
    await selectSaved("audio-native-recording-input", "")
    await context.evaluate(dashboard(null))
    const notice = await context.read(`JSON.stringify(document.body.innerText.includes("Audio device changes apply after the recording stops."))`, z.boolean())
    await observe("change-devices-during-take", started, { sinceTakeStart: JSON.stringify(before), noticeShown: notice })
    await tone
    const first = await finishRecording(context, { before: clips, file: path.join(out, "take-1.wav") })
    const moved = await awaitMore(out, "device-session", started["device-session"]).then(() => true, () => false)
    await observe("recording-finished", started, { moved, takeKeptBlackholeInput: first.passed })
    const secondClips = await startRecording(context)
    await playToneIntoBlackhole(path.join(out, "tone-take-2.wav"), toneSeconds)
    // The default input may refuse the take (microphone permission); the failure is marked, not a setup failure.
    const second = await finishRecording(context, { before: secondClips, file: path.join(out, "take-2.wav") }).then((take) => `tone heard: ${take.passed}`, (error) => `no take: ${error instanceof Error ? error.message : String(error)}`)
    await observe("next-take", started, { secondTake: second })
  }
  return new Map<string, () => Promise<void>>([
    ["out-play", play],
    ["out-to-blackhole-playing", switchTo(blackhole, "session")],
    ["out-to-speakers-playing", switchTo("speakers", "session")],
    ["out-reselect-speakers-playing", switchTo("speakers", "none")],
    ["out-pause", pause],
    ["out-to-blackhole-paused", switchTo(blackhole, "configure")],
    ["out-play-after-paused-switch", play],
    ["out-pause-again", pause],
    ["out-to-speakers-paused", switchTo("speakers", "configure")],
    ["out-play-back-on-speakers", play],
    ["out-to-missing-playing", switchToMissing],
    ["out-play-with-missing", playWithMissing],
    ["out-restore-speakers", switchTo("speakers", "none")],
    ["out-play-after-restore", play],
    ["out-recording-keeps-devices", recordingKeepsDevices],
  ])
}
