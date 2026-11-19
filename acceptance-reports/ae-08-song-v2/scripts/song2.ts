import { apply, track, trackRef, T, ref } from "/tmp/song/ctl.ts"

// v2 of the "Macros - Coming Soon" score. Beat b sounds at T(b) = 0.1 + 0.5 b s (120 BPM).
// Sections follow the trailer cuts: intro 0-7, Search 7-15, Scan 15-23, Rings 23-33, Track 33-41,
// Glance 41-48, "Scan. Done." 48-52, end card 52-58.
const blue = "#1E7BFF", orange = "#FF9F0A", pink = "#E9558A"

type Note = { beat: number; length: number; pitch: number; velocity: number }
const note = (beat: number, length: number, pitch: number, velocity: number): Note =>
  ({ beat: Number(beat.toFixed(4)), length: Number(length.toFixed(4)), pitch, velocity: Number(Math.min(1, Math.max(0.05, velocity)).toFixed(3)) })

// Deterministic humanization: small velocity and timing offsets that repeat run to run.
let seed = 0x5eed
const jitter = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }
const human = (n: Note, vel = 0.05, time = 0): Note => note(Math.max(0, n.beat + jitter() * time), n.length, n.pitch, n.velocity + jitter() * vel)

// ---- Harmony: the royal-road progression, holding the tonic back until the end card ----
type Chord = "Fmaj9" | "G6" | "Em7" | "Am7" | "Dm9" | "Gsus" | "G7" | "Cadd9"
const chords: Array<[number, number, Chord]> = [
  [0, 4, "Fmaj9"], [4, 7, "G6"],
  [7, 11, "Fmaj9"], [11, 15, "G6"], [15, 19, "Em7"], [19, 23, "Am7"],
  [23, 27, "Fmaj9"], [27, 29, "G6"], [29, 31, "Em7"], [31, 33, "Am7"],
  [33, 37, "Dm9"], [37, 39, "Gsus"], [39, 41, "G7"],
  [41, 45, "Fmaj9"], [45, 48, "Em7"],
  [48, 50, "Fmaj9"], [50, 52, "G6"], [52, 58, "Cadd9"],
]
const voicing: Record<Chord, number[]> = {
  Fmaj9: [53, 57, 60, 64, 67], G6: [55, 59, 62, 64, 67], Em7: [52, 55, 59, 62, 67], Am7: [52, 57, 60, 64, 67],
  Dm9: [50, 53, 57, 60, 64], Gsus: [55, 60, 62, 65, 67], G7: [55, 59, 62, 65, 67], Cadd9: [48, 55, 60, 62, 64, 67],
}
const root: Record<Chord, number> = { Fmaj9: 41, G6: 43, Em7: 40, Am7: 45, Dm9: 38, Gsus: 43, G7: 43, Cadd9: 36 }
const chordAt = (beat: number) => chords.find(([from, to]) => beat >= from && beat < to)![2]

const padNotes = () => chords.flatMap(([from, to, chord]) => {
  const level = from < 7 ? 0.5 : from >= 41 && from < 48 ? 0.5 : from >= 52 ? 0.75 : 0.62
  return voicing[chord].map((pitch, i) => human(note(from, to - from - 0.04, pitch, level - i * 0.03), 0.03))
})
// The air layer doubles the top of each voicing an octave up, from the Scan section on.
const airNotes = () => chords.filter(([from]) => from >= 15).flatMap(([from, to, chord]) =>
  voicing[chord].slice(-2).map((pitch) => note(from, to - from - 0.04, pitch + 12, from >= 52 ? 0.7 : 0.5)))

// ---- Bass: syncopated, locked around a four-on-the-floor kick ----
const bassNotes = () => {
  const out: Note[] = []
  const bar = (start: number, length: number, pattern: Array<[number, number, number, number]>) => {
    for (const [offset, len, interval, vel] of pattern) if (offset < length) out.push(human(note(start + offset, len, root[chordAt(start)] + interval, vel), 0.04))
  }
  const sparse: Array<[number, number, number, number]> = [[0, 1.4, 0, 0.9], [1.5, 0.4, 0, 0.7], [2.5, 0.9, 0, 0.8], [3.5, 0.4, 12, 0.65]]
  const drive: Array<[number, number, number, number]> = [[0, 0.3, 0, 0.9], [0.5, 0.35, 0, 0.78], [1.5, 0.35, 0, 0.74], [2, 0.22, 12, 0.6], [2.5, 0.35, 0, 0.8], [3.5, 0.3, 0, 0.74], [3.75, 0.2, 7, 0.55]]
  const pump: Array<[number, number, number, number]> = [[0, 0.3, 0, 0.92], [0.5, 0.35, 0, 0.8], [1.5, 0.35, 12, 0.62]]
  for (const [from, to] of chords) {
    if (from >= 7 && from < 15) bar(from, to - from, sparse)
    else if ((from >= 15 && from < 23) || (from >= 33 && from < 41)) bar(from, to - from, drive)
    else if (from >= 23 && from < 33) for (let b = from; b < to; b += 2) bar(b, Math.min(2, to - b), pump)
  }
  out.push(note(41, 3.8, root.Fmaj9, 0.8), note(45, 2.8, root.Em7, 0.75))
  out.push(note(48, 1.8, root.Fmaj9, 0.95), note(50, 1.8, root.G6, 0.95), note(52, 5.6, root.Cadd9, 1))
  return out
}

// ---- Hook ----
const phrase = (start: number, cells: Array<[number, number, number]>, vel: number) =>
  cells.map(([offset, length, pitch], i) => human(note(start + offset, length, pitch, vel + (offset % 1 === 0 ? 0.06 : 0) - (i % 2) * 0.03), 0.03))
const statement: Array<[number, number, number]> = [[0, 0.5, 76], [0.5, 0.5, 74], [1, 0.75, 72], [1.75, 0.75, 69], [2.5, 0.5, 72], [3, 1, 76], [4, 0.5, 74], [4.5, 0.25, 72], [4.75, 0.75, 74], [5.5, 1.5, 79]]
const answer: Array<[number, number, number]> = [[0, 0.5, 76], [0.5, 0.5, 74], [1, 0.75, 72], [1.75, 0.75, 71], [2.5, 0.5, 67], [3, 1, 71], [4, 0.5, 72], [4.5, 0.25, 74], [4.75, 0.75, 76], [5.5, 1, 72], [6.5, 1.25, 69]]
const chorus: Array<[number, number, number]> = [[0, 0.5, 79], [0.5, 0.5, 76], [1, 0.5, 79], [1.5, 0.75, 81], [2.25, 0.75, 79], [3, 1, 76], [4, 0.5, 74], [4.5, 0.5, 76], [5, 1, 79], [6, 0.5, 79], [6.5, 0.5, 76], [7, 1, 74], [8, 0.5, 76], [8.5, 0.5, 72], [9, 0.9, 69]]
const track_: Array<[number, number, number]> = [[0, 0.5, 69], [0.5, 0.5, 72], [1, 1, 74], [2.5, 0.5, 76], [3, 1, 77], [4, 0.75, 74], [4.75, 0.75, 72], [5.5, 0.5, 74], [6, 1.75, 71]]
const glance: Array<[number, number, number]> = [[0, 1.5, 76], [2, 0.5, 74], [2.5, 1.5, 72], [4, 1.5, 71], [5.5, 1.5, 67]]
const leadNotes = () => [
  ...phrase(7, statement, 0.78), ...phrase(15, answer, 0.8), ...phrase(23, chorus, 0.86), ...phrase(33, track_, 0.74),
  ...phrase(41, glance, 0.6), note(48, 1.6, 81, 0.9), note(50, 1.6, 83, 0.92), note(52, 5, 84, 0.95),
]
// The bell opens the score with a broken chord, sparkles an octave above the chorus, and carries the glance.
const bellNotes = () => [
  note(1, 1, 72, 0.6), note(2, 1, 76, 0.55), note(3, 1, 79, 0.6), note(4.5, 2.3, 74, 0.55),
  ...phrase(23, chorus, 0.42).map((n) => ({ ...n, pitch: n.pitch + 12 })),
  ...phrase(41, glance, 0.62),
  note(52, 4, 79, 0.5), note(52.5, 4, 84, 0.45),
]

// ---- Arp: frozen sixteenths in a 3-3-2 accent pattern; eighths in the Track section ----
const arpNotes = () => {
  const out: Note[] = []
  const ladder = (chord: Chord) => { const top = voicing[chord].filter((p) => p >= 57).map((p) => p + 12); return [...top, ...top.slice(1, -1).reverse()] }
  for (let b = 23; b < 33 - 1e-9; b += 0.25) {
    const step = Math.round((b - 23) / 0.25), lad = ladder(chordAt(b)), accent = [0, 3, 6].includes(step % 8)
    out.push(note(b, 0.12, lad[step % lad.length], accent ? 0.78 : 0.48))
  }
  for (let b = 33; b < 41 - 1e-9; b += 0.5) {
    const step = Math.round((b - 33) / 0.5), lad = ladder(chordAt(b))
    out.push(note(b, 0.2, lad[step % lad.length] - 12, step % 2 === 0 ? 0.55 : 0.4))
  }
  return out
}
const textureNotes = () => [note(0, 7, 60, 0.7), note(41, 7, 60, 0.6), note(52, 6, 60, 0.75)]

// ---- Drums (kick 36, snare 38, clap 39, crash 49) and percussion (rim 37, hat 42, shaker 44, open hat 46) ----
const kick = 36, rim = 37, snare = 38, clap = 39, hat = 42, shaker = 44, ohat = 46, crash = 49
const backbeat = (b: number) => (b - 7) % 2 === 1
const drumNotes = () => {
  const out: Note[] = []
  const hit = (b: number, pitch: number, v: number, len = 0.25) => out.push(human(note(b, len, pitch, v), 0.04))
  for (const [b, v] of [[7, 0.6], [23, 0.95], [33, 0.7], [41, 0.6], [48, 0.85], [50, 0.85], [52, 1]] as const) hit(b, crash, v, 1)
  for (let b = 7; b < 41; b++) {
    if (b >= 39) continue
    hit(b, kick, b % 4 === 3 ? 0.97 : 0.92)
    if (b >= 15 && backbeat(b)) { hit(b, clap, 0.85); hit(b, snare, 0.5) }
    if (b >= 15 && (b - 7) % 4 === 2) hit(b + 0.75, snare, 0.22)
  }
  hit(14.5, kick, 0.6)
  for (const [i, b] of [22, 22.25, 22.5, 22.75].entries()) hit(b, snare, 0.45 + i * 0.15)
  for (let i = 0; i < 8; i++) hit(32 + i * 0.125, snare, 0.35 + i * 0.08, 0.1)
  hit(39, clap, 0.8); hit(40.5, snare, 0.55); hit(40.75, snare, 0.75)
  for (const b of [41, 42.5, 45, 46.5]) hit(b, kick, 0.9)
  for (const b of [43, 47]) { hit(b, clap, 0.8); hit(b, snare, 0.45) }
  for (const b of [48, 50]) { hit(b, kick, 1); hit(b, clap, 0.9) }
  for (let i = 0; i < 8; i++) hit(51 + i * 0.125, snare, 0.3 + i * 0.09, 0.1)
  hit(52, kick, 1)
  return out
}
const percNotes = () => {
  const out: Note[] = []
  const hit = (b: number, pitch: number, v: number, len = 0.1) => out.push(human(note(b, len, pitch, v), 0.05, 0.008))
  const accent = [0.55, 0.25, 0.4, 0.27]
  for (let b = 3; b < 48; b += 0.25) {
    const step = Math.round(b * 4) % 4
    const intensity = b < 7 ? 0.35 + 0.65 * (b - 3) / 4 : b >= 41 ? 0.6 : 1
    hit(b, shaker, accent[step] * intensity)
  }
  for (let b = 11; b < 15; b++) hit(b + 0.5, hat, 0.5)
  for (let b = 15; b < 23; b++) { hit(b, hat, 0.3); hit(b + 0.5, (b - 7) % 4 === 3 ? ohat : hat, 0.58) }
  for (let b = 23; b < 33; b++) for (const [o, v] of [[0, 0.32], [0.25, 0.2], [0.5, 0.62], [0.75, 0.22]] as const)
    hit(b + o, o === 0.5 && (b - 7) % 4 === 3 ? ohat : hat, v)
  for (let b = 33; b < 39; b++) { hit(b + 0.5, (b - 7) % 4 === 3 ? ohat : hat, 0.55); if ((b - 7) % 2 === 0) hit(b + 0.75, rim, 0.42) }
  for (let b = 41; b < 48; b += 0.5) hit(b, hat, 0.28)
  return out
}

// ---- Steps ----
const target = (s: any, name: string) => ({ kind: "track", track: trackRef(s, name) })
const asset = (s: any, name: string) => {
  const found = s.assets.find((a: any) => a.name === `${name}.wav`)
  if (!found) throw new Error(`No asset ${name}.wav`)
  return found
}
const sampleOf = (a: any) => ({ assetKey: a.id, url: `local-asset:${a.id}`, name: a.name, sourceKind: a.sourceKind,
  source: { durationSec: a.durationSec, sampleRate: a.sampleRate, channelCount: a.channelCount } })
const zoneOf = (a: any, id: string, rootNote: number) => ({ id, sample: sampleOf(a), keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote, tuneCents: 0,
  gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: "one-shot", startSec: 0, endSec: a.durationSec, crossfadeSec: 0, chokeGroup: 0 })
const instrumentParams = (s: any, name: string) => {
  const found = s.processors.find((p: any) => p.target.trackId === track(s, name).id && p.processor.kind === "instrument")
  if (!found) throw new Error(`No instrument on ${name}`)
  return found.processor.params.params
}
const instrumentTracks: Array<[string, string, string]> = [
  ["Drums", "drum-rack", blue], ["Perc", "drum-rack", blue], ["Bass", "synth", blue], ["Pad", "synth", orange], ["Air", "synth", orange],
  ["Lead", "synth", pink], ["Bell", "sampler", pink], ["Arp", "synth", pink], ["Texture", "granular", orange],
]
export const steps: Record<string, () => Promise<unknown>> = {}
steps.setup = () => apply("v2-setup", (s) => [
  { kind: "project.rename", name: "Macros - Coming Soon (score v2)" },
  { kind: "project.settings.set", tempoBpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, loopEnabled: true, loopStartSec: 0, loopEndSec: 29 },
  ...s.clips.map((clip: any) => ({ kind: "clip.delete", clip: ref(clip.id) })),
  { kind: "track.rename", track: trackRef(s, "Track 1"), name: "Rise" },
  { kind: "track.color.set", track: trackRef(s, "Track 1"), color: blue },
  ...(s.tracks.some((t: any) => t.name === "Track 2")
    ? [{ kind: "track.rename", track: trackRef(s, "Track 2"), name: "Impact" }, { kind: "track.color.set", track: trackRef(s, "Track 2"), color: pink }]
    : [{ kind: "track.create", clientRef: "impact", name: "Impact", trackKind: "audio", color: pink }]),
  ...s.tracks.filter((t: any) => /^Track \d+$/.test(t.name) && !["Track 1", "Track 2"].includes(t.name)).map((t: any) => ({ kind: "track.delete", track: ref(t.id) })),
  ...instrumentTracks.map(([name, , color]) => ({ kind: "track.create", clientRef: name.toLowerCase(), name, trackKind: "instrument", color })),
  { kind: "track.create", clientRef: "voice", name: "Voice", trackKind: "audio", color: orange },
  { kind: "track.create", clientRef: "reverb", name: "Reverb", trackKind: "audio", channelRole: "return", color: blue },
  { kind: "track.create", clientRef: "echo", name: "Echo", trackKind: "audio", channelRole: "return", color: blue },
])
steps.instruments = () => apply("v2-instruments", (s) => instrumentTracks.map(([name, kind]) => ({ kind: "instrument.set", target: target(s, name), instrumentKind: kind })))

const synth = (base: any, patch: any) => ({ ...base, ...patch, version: 2 })
const osc = (wave: string, level: number, extra: any = {}) => ({ enabled: true, wave, octave: 0, semitone: 0, detuneCents: 0, level, ...extra })
const envl = (attackSec: number, decaySec: number, sustain: number, releaseSec: number) => ({ attackSec, decaySec, sustain, releaseSec })
steps.patches = () => apply("v2-patches", (s) => {
  const padMap: Record<number, [string, number, number, number]> = {
    36: ["kick", 1, 0, 0], 37: ["rim", 0.5, 0, 0.1], 38: ["snare", 0.75, 0, 0], 39: ["clap", 0.8, 0, 0], 49: ["crash", 0.5, 0, -0.1],
    42: ["hat", 0.55, 1, 0.18], 44: ["shaker", 0.5, 0, -0.2], 46: ["ohat", 0.5, 1, 0.18],
  }
  const rack = (name: string, notes: number[]) => {
    const params = instrumentParams(s, name)
    return { ...params, pads: params.pads.map((pad: any) => {
      const entry = notes.includes(pad.note) ? padMap[pad.note] : undefined
      if (!entry) return pad
      const [file, gain, choke, pan] = entry
      return { ...pad, name: file, sample: sampleOf(asset(s, file)), gain, chokeGroup: choke, pan }
    }) }
  }
  const p = (name: string) => instrumentParams(s, name)
  return [
    { kind: "instrument.set", target: target(s, "Drums"), instrumentKind: "drum-rack", params: rack("Drums", [36, 38, 39, 49]) },
    { kind: "instrument.set", target: target(s, "Perc"), instrumentKind: "drum-rack", params: rack("Perc", [37, 42, 44, 46]) },
    { kind: "instrument.set", target: target(s, "Bass"), instrumentKind: "synth", params: synth(p("Bass"), {
      oscillators: [osc("sawtooth", 0.42), osc("sine", 0.85, { octave: -1 })],
      ampEnvelope: envl(0.003, 0.35, 0.7, 0.07),
      filter: { enabled: true, mode: "lowpass", frequencyHz: 360, q: 0.9, keyTracking: 0.4, envelopeAmountOctaves: 2.3, envelope: envl(0.001, 0.16, 0.15, 0.1) },
      lfo: { ...p("Bass").lfo, enabled: false }, noise: { enabled: false, level: 0 }, polyphony: 1, retrigger: true, gain: 0.85 }) },
    { kind: "instrument.set", target: target(s, "Pad"), instrumentKind: "synth", params: synth(p("Pad"), {
      oscillators: [osc("sawtooth", 0.5, { detuneCents: -11 }), osc("sawtooth", 0.5, { detuneCents: 11 })],
      ampEnvelope: envl(0.7, 1.6, 0.85, 1.8),
      filter: { enabled: true, mode: "lowpass", frequencyHz: 1500, q: 0.55, keyTracking: 0.25, envelopeAmountOctaves: 0.8, envelope: envl(1, 2, 0.4, 1.5) },
      lfo: { enabled: true, wave: "sine", frequencyHz: 0.17, pitchCents: 3, filterOctaves: 0.25, amp: 0, pan: 0.25 },
      noise: { enabled: true, level: 0.03 }, polyphony: 16, retrigger: false, gain: 0.55 }) },
    { kind: "instrument.set", target: target(s, "Air"), instrumentKind: "synth", params: synth(p("Air"), {
      oscillators: [osc("triangle", 0.6), osc("sine", 0.3, { octave: 1 })],
      ampEnvelope: envl(1.2, 2, 0.8, 2.2),
      filter: { enabled: true, mode: "lowpass", frequencyHz: 6000, q: 0.5, keyTracking: 0, envelopeAmountOctaves: 0, envelope: envl(0.01, 0.1, 1, 0.1) },
      lfo: { enabled: true, wave: "triangle", frequencyHz: 4.5, pitchCents: 6, filterOctaves: 0, amp: 0.1, pan: 0 },
      noise: { enabled: false, level: 0 }, polyphony: 12, retrigger: false, gain: 0.4 }) },
    { kind: "instrument.set", target: target(s, "Lead"), instrumentKind: "synth", params: synth(p("Lead"), {
      oscillators: [osc("triangle", 0.6), osc("sawtooth", 0.2, { octave: 1, detuneCents: 4 })],
      ampEnvelope: envl(0.002, 0.5, 0.3, 0.35),
      filter: { enabled: true, mode: "lowpass", frequencyHz: 1600, q: 1.1, keyTracking: 0.5, envelopeAmountOctaves: 3, envelope: envl(0.001, 0.25, 0.15, 0.2) },
      lfo: { enabled: true, wave: "sine", frequencyHz: 5.2, pitchCents: 4, filterOctaves: 0, amp: 0, pan: 0 },
      noise: { enabled: false, level: 0 }, polyphony: 6, retrigger: true, gain: 0.7 }) },
    { kind: "instrument.set", target: target(s, "Arp"), instrumentKind: "synth", params: synth(p("Arp"), {
      oscillators: [osc("sawtooth", 0.35, { detuneCents: -5 }), osc("triangle", 0.3, { octave: 1 })],
      ampEnvelope: envl(0.001, 0.14, 0, 0.1),
      filter: { enabled: true, mode: "lowpass", frequencyHz: 2400, q: 1.3, keyTracking: 0.4, envelopeAmountOctaves: 2.2, envelope: envl(0.001, 0.09, 0, 0.06) },
      lfo: { ...p("Arp").lfo, enabled: false }, noise: { enabled: false, level: 0 }, polyphony: 8, retrigger: true, gain: 0.55 }) },
    { kind: "instrument.set", target: target(s, "Bell"), instrumentKind: "sampler", params: {
      ...p("Bell"), zones: [zoneOf(asset(s, "bell"), "bell-zone", 72)],
      ampEnvelope: { ...p("Bell").ampEnvelope, attackSec: 0.002, decaySec: 2.5, sustain: 0, releaseSec: 0.6 }, filterFrequencyHz: 12000, polyphony: 16 } },
    { kind: "instrument.set", target: target(s, "Texture"), instrumentKind: "granular", params: {
      ...p("Texture"), zone: zoneOf(asset(s, "texture"), "texture-zone", 60), grainSizeMs: 180, densityHz: 26, position: 0.35, spray: 0.3, stereoSpread: 0.9, reverseProbability: 0.15 } },
  ]
})

const midiClip = (s: any, name: string, notes: Note[], clipName: string) => {
  if (notes.length > 500) throw new Error(`${clipName}: ${notes.length} notes`)
  return { kind: "clip.midi.create", track: trackRef(s, name), name: clipName, startSec: T(0), duration: 29.9, wave: "sine", notes }
}
steps.clips = () => apply("v2-clips", (s) => [
  midiClip(s, "Pad", padNotes(), "Chords"), midiClip(s, "Air", airNotes(), "Air"), midiClip(s, "Bass", bassNotes(), "Bass"),
  midiClip(s, "Lead", leadNotes(), "Hook"), midiClip(s, "Bell", bellNotes(), "Bell"), midiClip(s, "Arp", arpNotes(), "Arp (frozen)"),
  midiClip(s, "Texture", textureNotes(), "Texture"),
])
steps["clips-2"] = () => apply("v2-clips-2", (s) => {
  const audio = (trackName: string, file: string, startSec: number, gain: number, duration?: number) => ({
    kind: "clip.audio.create", track: trackRef(s, trackName), asset: ref(asset(s, file).id), name: file, startSec: Number(startSec.toFixed(4)), gain,
    ...(duration === undefined ? {} : { duration }) })
  return [
    midiClip(s, "Drums", drumNotes(), "Beat"), midiClip(s, "Perc", percNotes(), "Percussion"),
    audio("Rise", "riser-long", T(7) - 3.4, 0.8), audio("Rise", "riser-short", T(23) - 1, 0.7), audio("Rise", "riser-short", T(33) - 1, 0.6),
    audio("Rise", "swell", T(41) - 1.5, 0.6), audio("Rise", "swell", T(48) - 1.5, 0.75), audio("Rise", "swell", T(52) - 1.5, 0.8),
    audio("Impact", "impact", T(23), 0.6), audio("Impact", "impact", T(48), 0.85, 2), audio("Impact", "impact", T(52), 1),
    audio("Voice", "voice", 26.65, 1),
  ]
})

// ---- Devices ----
const effectPlan: Array<[string, string[]]> = [
  ["Drums", ["compressor", "saturator"]], ["Perc", ["eq"]], ["Bass", ["eq", "saturator", "compressor"]],
  ["Pad", ["eq", "autofilter", "ensemble"]], ["Air", ["eq", "chorus"]], ["Lead", ["eq", "chorus", "delay"]],
  ["Bell", ["eq"]], ["Arp", ["eq", "autopan"]], ["Texture", ["eq", "chorus"]], ["Rise", ["eq"]], ["Voice", ["eq", "compressor"]],
  ["Reverb", ["eq", "reverb"]], ["Echo", ["delay", "eq"]],
]
steps.effects = () => apply("v2-effects", (s) => [
  ...effectPlan.flatMap(([name, kinds]) => kinds.map((effectKind) => ({ kind: "effect.upsert", target: target(s, name), effectKind }))),
  ...["eq", "compressor", "limiter"].map((effectKind) => ({ kind: "effect.upsert", target: { kind: "master" }, effectKind })),
])
const fx = (s: any, name: string, kind: string) => {
  const list = name === "Master" ? s.processors.filter((p: any) => p.target.master) : s.processors.filter((p: any) => p.target.trackId === track(s, name).id)
  const found = list.find((p: any) => p.processor.kind === kind)
  if (!found) throw new Error(`No ${kind} on ${name}`)
  return found
}
const tune = (s: any, name: string, kind: string, change: (params: any) => any) => {
  const processor = fx(s, name, kind)
  const params = processor.processor.params
  const next = params.state !== undefined ? { ...params, state: change(params.state) } : change(params)
  return { kind: "effect.upsert", target: name === "Master" ? { kind: "master" } : target(s, name), effect: ref(processor.id), effectKind: kind, params: next }
}
const band = (id: string, type: string, frequency: number, gainDb: number, q = 0.7) => ({ id, type, frequency, gainDb, q, enabled: true })
const eq = (...bands: ReturnType<typeof band>[]) => (p: any) => ({ ...p, bands })
steps.tune = () => apply("v2-tune", (s) => [
  tune(s, "Drums", "compressor", (p) => ({ ...p, thresholdDb: -16, ratio: 3, attackMs: 15, releaseMs: 90, makeupDb: 2, dryWet: 0.8 })),
  tune(s, "Drums", "saturator", (p) => ({ ...p, driveDb: 3, curve: "soft", dryWet: 0.3, outputDb: -1 })),
  tune(s, "Perc", "eq", eq(band("hp", "highpass", 500, 0), band("air", "highshelf", 11000, -1.5))),
  tune(s, "Bass", "eq", eq(band("hp", "highpass", 32, 0), band("box", "peaking", 260, -2.5, 1), band("lp", "lowpass", 4500, 0))),
  tune(s, "Bass", "saturator", (p) => ({ ...p, driveDb: 4, curve: "soft", dryWet: 0.3, outputDb: -1 })),
  tune(s, "Bass", "compressor", (p) => ({ ...p, thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 120, autoRelease: false, makeupDb: 2, sidechain: { ...p.sidechain, enabled: false } })),
  tune(s, "Pad", "eq", eq(band("hp", "highpass", 220, 0), band("mud", "peaking", 450, -3, 1), band("air", "highshelf", 9000, 1.5))),
  tune(s, "Pad", "autofilter", (p) => ({ ...p, frequencyHz: 600, resonance: 0.2 })),
  tune(s, "Pad", "ensemble", (p) => ({ ...p, mix: 0.45 })),
  tune(s, "Air", "eq", eq(band("hp", "highpass", 600, 0))),
  tune(s, "Air", "chorus", (p) => ({ ...p, mix: 0.35 })),
  tune(s, "Lead", "eq", eq(band("hp", "highpass", 250, 0), band("presence", "peaking", 3000, 2, 0.8), band("soft", "highshelf", 10000, -2))),
  tune(s, "Lead", "chorus", (p) => ({ ...p, mix: 0.2 })),
  tune(s, "Lead", "delay", (p) => ({ ...p, mode: "sync", syncDivision: "1/8", pingPong: true, feedback: 0.28, dryWet: 0.12, filterEnabled: true, lowCutHz: 300, highCutHz: 5500 })),
  tune(s, "Bell", "eq", eq(band("hp", "highpass", 400, 0), band("soft", "highshelf", 9000, -2))),
  tune(s, "Arp", "eq", eq(band("hp", "highpass", 400, 0), band("soft", "highshelf", 8000, -3))),
  tune(s, "Arp", "autopan", (p) => ({ ...p, rateHz: 0.25, depth: 0.4 })),
  tune(s, "Texture", "eq", eq(band("hp", "highpass", 300, 0))),
  tune(s, "Texture", "chorus", (p) => ({ ...p, mix: 0.3 })),
  tune(s, "Rise", "eq", eq(band("hp", "highpass", 200, 0))),
  tune(s, "Voice", "eq", eq(band("hp", "highpass", 120, 0), band("presence", "peaking", 3500, 3, 0.9))),
  tune(s, "Voice", "compressor", (p) => ({ ...p, thresholdDb: -24, ratio: 3, attackMs: 5, releaseMs: 100, makeupDb: 3 })),
  tune(s, "Reverb", "eq", eq(band("hp", "highpass", 250, 0), band("lp", "lowpass", 8000, 0))),
  tune(s, "Reverb", "reverb", (p) => ({ ...p, wet: 1, decaySec: 2.6, preDelayMs: 22, size: 0.7, diffusion: 0.8, density: 0.8, diffuse: 1, lowCutHz: 200, highCutHz: 7000, stereoWidth: 1 })),
  tune(s, "Echo", "delay", (p) => ({ ...p, mode: "sync", syncDivision: "1/4", pingPong: true, feedback: 0.35, dryWet: 1, filterEnabled: true, lowCutHz: 400, highCutHz: 4500 })),
  tune(s, "Echo", "eq", eq(band("hp", "highpass", 350, 0))),
  tune(s, "Master", "eq", eq(band("hp", "highpass", 28, 0))),
  tune(s, "Master", "compressor", (p) => ({ ...p, thresholdDb: -12, ratio: 2, attackMs: 30, releaseMs: 200, makeupDb: 1.5 })),
])

// track, volume, [reverb send, echo send]
const mix: Array<[string, number, number, number]> = [
  ["Drums", 0.9, 0.08, 0], ["Perc", 0.6, 0.08, 0], ["Bass", 0.8, 0, 0], ["Pad", 0.5, 0.3, 0], ["Air", 0.35, 0.45, 0],
  ["Lead", 0.7, 0.25, 0.18], ["Bell", 0.45, 0.4, 0.25], ["Arp", 0.42, 0.2, 0.1], ["Texture", 0.4, 0.35, 0],
  ["Rise", 0.5, 0.2, 0], ["Impact", 0.7, 0.25, 0], ["Voice", 1, 0.15, 0], ["Reverb", 0.7, 0, 0], ["Echo", 0.5, 0, 0],
]
steps.mix = () => apply("v2-mix", (s) => [
  ...mix.map(([name, volume]) => ({ kind: "track.mix.set", track: trackRef(s, name), volume })),
  ...mix.filter(([, , r, e]) => r > 0 || e > 0).map(([name, , r, e]) => ({
    kind: "track.routing.set", track: trackRef(s, name),
    sends: [...(r > 0 ? [{ target: trackRef(s, "Reverb"), amount: r, tap: "post-fader" }] : []), ...(e > 0 ? [{ target: trackRef(s, "Echo"), amount: e, tap: "post-fader" }] : [])] })),
  { kind: "master.volume.set", volume: 0.9 },
])
const lane = (s: any, name: string, kind: string, parameterId: string, points: Array<[number, number, "linear" | "hold"]>) => ({
  kind: "automation.set", target: target(s, name), effect: ref(fx(s, name, kind).id), parameterId, enabled: true,
  points: points.map(([beat, value, interpolation], index) => ({ id: `${parameterId}-${index}`, timeSec: Math.max(0, T(beat)), value, interpolation })),
})
steps.automation = () => apply("v2-automation", (s) => [
  // The pad opens through the intro, peaks in the chorus, darkens for the glance, and opens fully on the end card.
  lane(s, "Pad", "autofilter", "autofilter.frequencyHz", [[-0.2, 500, "linear"], [7, 3000, "linear"], [23, 6500, "hold"], [33, 3500, "hold"], [41, 900, "linear"], [47.5, 1100, "linear"], [48, 5000, "linear"], [52, 9000, "hold"]]),
  // A delay throw on the last hook note of the Track section.
  lane(s, "Lead", "delay", "delay.dryWet", [[-0.2, 0.12, "hold"], [39, 0.45, "hold"], [41, 0.12, "hold"]]),
])

// Mix polish after listening tests on the band-limited engine: lighter sub, more hook and top end, -1 dBTP ceiling.
steps.polish = () => apply("v2-polish", (s) => {
  const bass = instrumentParams(s, "Bass")
  return [
    { kind: "instrument.set", target: target(s, "Bass"), instrumentKind: "synth", params: synth(bass, {
      oscillators: [bass.oscillators[0], { ...bass.oscillators[1], level: 0.7 }] }) },
    tune(s, "Master", "limiter", (p) => ({ ...p, ceilingDbtp: -1, releaseMs: 120 })),
    ...([["Bass", 0.7], ["Lead", 0.8], ["Perc", 0.7], ["Bell", 0.52], ["Arp", 0.48]] as const).map(([name, volume]) => ({ kind: "track.mix.set", track: trackRef(s, name), volume })),
    { kind: "master.volume.set", volume: 1 },
  ]
})

if (import.meta.main) {
  for (const name of Bun.argv.slice(2)) {
    const step = steps[name]
    if (!step) throw new Error(`Unknown step ${name}`)
    await step()
  }
}
