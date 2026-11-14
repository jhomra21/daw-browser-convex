import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { PluginCatalogData } from "../../apps/desktop/plugin-catalog"
import { writeWav, type Pcm } from "./ae08-wav"
import { SetupFailure } from "./ae-08-phase-9-matrix"
import type { Row } from "./ae-08-phase-9-rows"

// What the phase 9 VST and hardware rows need from the machine, checked before the app starts so that a missing piece is a setup
// failure and never a pass. Everything is selected inside the private test profile; no system default is ever changed.

// ---- The phase 6 test plug-in, reachable through the private profile's catalog ----
// run-ae08-test-plugin.ts builds it here and never installs it into a VST3 folder.
export const testPluginBundle = "/tmp/ae08-p6z-native/plugin-host/ae08-test-effect.vst3"
export const catalogFileName = "plugin-catalog-v1.json"

const spawnText = async (argv: string[]) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

// Copies the bundle into a directory under the run's /tmp folder and writes the profile's plug-in catalog with that directory as its
// only configured one: the file and schema the catalog store's saveInternal writes. The app's initialize adds the standard
// directories to it and scans, and trust still goes through the real UI. Nothing is written to ~/Library or /Library.
export const seedPluginCatalog = async (profile: string, directory: string, bundle = testPluginBundle) => {
  const target = path.join(directory, "vst3-seed")
  await mkdir(target, { recursive: true })
  const copy = path.join(target, path.basename(bundle))
  if (!await Bun.file(path.join(bundle, "Contents/Info.plist")).exists()) throw new SetupFailure(`The phase 6 test plug-in is not built at ${bundle}: run tools/acceptance/run-ae08-test-plugin.ts`)
  await cp(bundle, copy, { recursive: true, verbatimSymlinks: true })
  // The catalog compares configured directories with real paths, and /tmp is a symlink on macOS.
  const catalog: PluginCatalogData = { version: 3, directories: [await realpath(target)], entries: [], diagnostics: [], scannedAtMs: null }
  await writeFile(path.join(profile, catalogFileName), JSON.stringify(catalog), { mode: 0o600 })
  return catalog
}

// ---- Devices ----
export const iacPort = "IAC Driver Bus 1"
export const blackhole = "BlackHole 2ch"
const swiftTool = path.join(import.meta.dir, "ae-08-iac-midi.swift")
const tool = async (...args: string[]) => {
  const result = await spawnText(["swift", swiftTool, ...args])
  if (result.code !== 0) throw new SetupFailure(`ae-08-iac-midi.swift ${args.join(" ")} failed: ${result.err.trim().split("\n").at(-1) ?? ""}`)
  return result.out
}

const audioDataSchema = z.object({ SPAudioDataType: z.array(z.object({ _items: z.array(z.object({ _name: z.string() })).default([]) })) })
export const audioDeviceNames = async () => audioDataSchema.parse(JSON.parse((await spawnText(["system_profiler", "SPAudioDataType", "-json"])).out))
  .SPAudioDataType.flatMap((group) => group._items.map((item) => item._name))
export const midiSourceNames = async () => (await tool("sources")).split("\n").filter(Boolean)

// A row that names a device needs it present: IAC in the CoreMIDI sources, BlackHole in system_profiler's audio devices.
export const requireDevice = (device: NonNullable<Row["device"]>, present: { midiSources: readonly string[]; audioDevices: readonly string[] }) => {
  if (device === "iac-midi" ? !present.midiSources.includes(iacPort) : !present.audioDevices.includes(blackhole))
    throw new SetupFailure(`${device === "iac-midi" ? iacPort : blackhole} is not present (${device === "iac-midi" ? "CoreMIDI sources" : "SPAudioDataType"}); the row cannot run`)
}
export const checkDevices = async (rows: readonly Row[]) => {
  const wanted = new Set(rows.flatMap((row) => row.device ? [row.device] : []))
  if (!wanted.size) return
  const present = { midiSources: wanted.has("iac-midi") ? await midiSourceNames() : [], audioDevices: wanted.has("blackhole") ? await audioDeviceNames() : [] }
  for (const device of wanted) requireDevice(device, present)
}

export const sendMidiNote = (action: "on" | "off", note: number) => tool("send", iacPort, action, String(note), "90")

// ---- The known tone, played into BlackHole only for the take, and the take's verification ----
const toneRate = 48000
// The first sample is not zero, so the take's first non-silent frame is the tone's first frame.
export const makeTone = (seconds: number): Pcm => {
  const frames = Math.round(seconds * toneRate)
  const samples = new Float32Array(frames * 2)
  for (let frame = 0; frame < frames; frame++) {
    const value = 0.25 * Math.sin(2 * Math.PI * 997 * frame / toneRate + 0.5)
    samples[frame * 2] = value; samples[frame * 2 + 1] = value
  }
  return { sampleRate: toneRate, channels: 2, samples }
}
export const playToneIntoBlackhole = async (file: string, seconds: number) => {
  await writeWav(file, makeTone(seconds))
  return tool("play", blackhole, file)
}

// Sample for sample: the first non-silent frame of the take starts the tone, and every frame of the tone must equal the take's, on
// each channel the take has. No tolerance: a loopback is digital.
export const verifyTakeAgainstTone = (take: Pcm, tone: Pcm) => {
  const channels = Math.min(take.channels, tone.channels)
  const frames = take.samples.length / take.channels
  const toneFrames = tone.samples.length / tone.channels
  const first = Array.from({ length: frames }, (_, frame) => frame).find((frame) => take.samples.subarray(frame * take.channels, (frame + 1) * take.channels).some((value) => value !== 0)) ?? -1
  if (first < 0 || take.sampleRate !== tone.sampleRate || first + toneFrames > frames) return { passed: false, offset: first, mismatches: toneFrames * channels }
  let mismatches = 0
  for (let frame = 0; frame < toneFrames; frame++)
    for (let channel = 0; channel < channels; channel++)
      if (take.samples[(first + frame) * take.channels + channel] !== tone.samples[frame * tone.channels + channel]) mismatches++
  return { passed: mismatches === 0, offset: first, mismatches }
}

// ---- Selecting the inputs inside the private profile (page side) ----
// The app's preferences live in the page's localStorage, which is the private profile's. Nothing here touches the system default.
const preferenceKey = "daw-browser.app-preferences.v1"
const writePreferences = (change: string) => `(()=>{const key=${JSON.stringify(preferenceKey)};
  const preferences=JSON.parse(localStorage.getItem(key)??"{}");preferences.version=9;${change};
  localStorage.setItem(key,JSON.stringify(preferences));return true})()`
export const selectAudioInputScript = (label: string) => `(async()=>{
  const device=(await navigator.mediaDevices.enumerateDevices()).find(entry=>entry.kind==="audioinput"&&entry.label.includes(${JSON.stringify(label)}));
  if(!device)throw new Error(${JSON.stringify(`${label} is not an audio input of the private profile`)});
  return ${writePreferences("preferences.audio={...preferences.audio,inputDeviceId:device.deviceId}")};
})()`
export const selectMidiInputScript = (name: string) => `(async()=>{
  const access=await navigator.requestMIDIAccess({sysex:false});
  const input=[...access.inputs.values()].find(entry=>entry.name===${JSON.stringify(name)});
  if(!input)throw new Error(${JSON.stringify(`${name} is not a MIDI input of the private profile`)});
  return ${writePreferences("preferences.midi={selectedInputIds:[input.id]}")};
})()`

// ---- Self-test ----
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 devices self-test: ${message}`) }
const refused = (action: () => void) => { try { action() } catch (error) { return error instanceof SetupFailure } return false }

export const selfTest = async () => {
  // A row's device must be present; an absent one is a setup failure, never a pass.
  const both = { midiSources: [iacPort], audioDevices: [blackhole] }
  check(!refused(() => requireDevice("iac-midi", both)) && !refused(() => requireDevice("blackhole", both)), "present devices pass")
  check(refused(() => requireDevice("iac-midi", { ...both, midiSources: [] })), "an absent IAC bus is a setup failure")
  check(refused(() => requireDevice("blackhole", { ...both, audioDevices: ["MacBook Pro Microphone"] })), "an absent BlackHole is a setup failure")
  check(refused(() => requireDevice("blackhole", { ...both, audioDevices: ["BlackHole 16ch"] })), "another BlackHole channel count is not BlackHole 2ch")
  // The seeded catalog: the profile's own file, the schema saveInternal writes, the directory by its real path, nothing outside the run.
  const run = await mkdtemp(path.join(tmpdir(), "ae08-phase9-devices-"))
  try {
    const bundle = path.join(run, "built", "ae08-test-effect.vst3")
    await mkdir(path.join(bundle, "Contents"), { recursive: true })
    await writeFile(path.join(bundle, "Contents/Info.plist"), "plist")
    const profile = path.join(run, "profile")
    await mkdir(profile)
    const catalog = await seedPluginCatalog(profile, run, bundle)
    const written = JSON.parse(await readFile(path.join(profile, catalogFileName), "utf8"))
    const seeded = await realpath(path.join(run, "vst3-seed"))
    check(JSON.stringify(written) === JSON.stringify(catalog) && written.version === 3 && written.directories.join() === seeded && written.entries.length === 0 && written.scannedAtMs === null,
      `catalog ${JSON.stringify(written)}`)
    check(await Bun.file(path.join(seeded, "ae08-test-effect.vst3/Contents/Info.plist")).exists(), "the bundle is copied into the seeded directory")
    const missing = await seedPluginCatalog(profile, run, path.join(run, "no-such.vst3")).then(() => false, (error) => error instanceof SetupFailure)
    check(missing, "an unbuilt test plug-in is a setup failure")
  } finally { await rm(run, { recursive: true }) }
  // The take must be the tone sample for sample, from its first non-silent frame.
  const tone = makeTone(0.1)
  const frames = tone.samples.length / 2
  const take = (lead: number, change?: (samples: Float32Array) => void): Pcm => {
    const samples = new Float32Array((lead + frames + 10) * 2)
    samples.set(tone.samples, lead * 2)
    change?.(samples)
    return { sampleRate: tone.sampleRate, channels: 2, samples }
  }
  check(verifyTakeAgainstTone(take(0), tone).passed && verifyTakeAgainstTone(take(777), tone).offset === 777, "an exact take passes at its own offset")
  check(!verifyTakeAgainstTone(take(100, (samples) => { samples[(100 + 500) * 2 + 1] += 1e-7 }), tone).passed, "one sample off by 1e-7 fails")
  check(!verifyTakeAgainstTone({ ...take(100), samples: take(100).samples.subarray(0, 200 * 2) }, tone).passed, "a take shorter than the tone fails")
  check(!verifyTakeAgainstTone({ sampleRate: 48000, channels: 2, samples: new Float32Array(1000) }, tone).passed, "a silent take fails")
  // The selection scripts touch only the page's preferences for the named device.
  check(selectAudioInputScript(blackhole).includes("inputDeviceId") && selectAudioInputScript(blackhole).includes(preferenceKey) && !selectAudioInputScript(blackhole).includes("setSinkId"), "BlackHole is selected in the profile's preferences")
  check(selectMidiInputScript(iacPort).includes("selectedInputIds") && selectMidiInputScript(iacPort).includes(JSON.stringify(iacPort)), "IAC is selected in the profile's preferences")
  console.log("ae-08 phase 9 devices self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else throw new Error("Usage: ae-08-phase-9-devices.ts --self-test")
}
