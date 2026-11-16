import { watch } from "node:fs"
import { z } from "zod"
import { nativeEvents } from "./ae-08-phase-9-matrix"
import { waitForUi, type Phase5Context } from "./ae-08-phase-5-fixture"
import { blackhole } from "./ae-08-phase-9-devices"
import { armRecordTarget, startRecording } from "./ae-08-phase-9-record"

// The saved native output device changed in Audio settings while the transport plays, is paused, or records. Every step goes through the
// product's own Audio settings select and marks the host's lifecycle lines it saw (`device-switch-observed`); the row has no judge, the
// evidence is read per step: a changed device rebuilds the session in the same host, an unchanged one does not, and a take keeps its devices.
const lifecycleEvents = ["device-session", "device-stop", "device-configure", "device-start-request", "structural-rebuild", "host-spawn", "host-exit"]
const switchDeadlineMs = 6_000

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
    await context.mark("device-switch-observed", { step, before: JSON.stringify(before), after: JSON.stringify(await countsOf(out)), state: status.state,
      playheadSec: status.playheadSec, saved: await context.read(savedOutputScript, z.string()), ...extra })
  }
  const choose = async (name: string) => {
    const devices = await context.read(outputDevicesScript, outputDevices)
    const device = devices.find((entry) => entry.name === name) ?? devices.find((entry) => name === "speakers" && entry.name !== blackhole)
    if (!device) throw new Error(`${name} is not a native audio output of the private profile`)
    await context.evaluate(dashboard("audio"))
    await waitForUi(context, "The Audio settings output select never rendered", `document.querySelector('#audio-native-playback-output option[value=${JSON.stringify(device.deviceId)}]')!==null`)
    await context.evaluate(`(()=>{const select=document.querySelector('#audio-native-playback-output');select.value=${JSON.stringify(device.deviceId)};select.dispatchEvent(new Event("change",{bubbles:true}));return true})()`)
    await context.evaluate(dashboard(null))
    return device
  }
  const switchTo = (name: string, rebuilds: "session" | "configure" | "none") => async () => {
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
  const recordingKeepsDevices = async () => {
    await context.evaluate(press("Stop"))
    await armRecordTarget(context)
    const before = await countsOf(out)
    await startRecording(context)
    const started = await countsOf(out)
    await choose(blackhole)
    const notice = await context.read(`JSON.stringify(document.body.innerText.includes("Audio device changes apply after the recording stops."))`, z.boolean())
    await observe("switch-to-blackhole-recording", started, { sinceTakeStart: JSON.stringify(before), noticeShown: notice })
    await context.evaluate(press("Stop recording"))
    await waitForUi(context, "Recording did not stop", `document.querySelector('button[aria-label="Start recording"]')?.getAttribute('aria-pressed')==='false'`)
    await waitForUi(context, "The recording never finished", `!document.body.textContent?.includes('Finishing recording')`)
    const moved = await awaitMore(out, "device-session", started["device-session"]).then(() => true, () => false)
    await observe("recording-finished", started, { moved })
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
    ["out-recording-keeps-devices", recordingKeepsDevices],
  ])
}
