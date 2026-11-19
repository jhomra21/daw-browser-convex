// Deterministic one-shot synthesis for song v2. 48 kHz, 24-bit stereo WAV.
import { mkdirSync, writeFileSync } from "node:fs"
const SR = 48000
const out = "/tmp/song2/samples"
mkdirSync(out, { recursive: true })

let seed = 0x2f6b1d
const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1 }
const n = (sec: number) => Math.round(sec * SR)
const noise = (len: number) => Float64Array.from({ length: len }, rand)

type Biquad = (x: Float64Array) => Float64Array
const biquad = (type: "lp" | "hp" | "bp", f: number | ((i: number) => number), q: number): Biquad => (x) => {
  const y = new Float64Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const fc = typeof f === "number" ? f : f(i)
    const w = 2 * Math.PI * Math.min(fc, SR * 0.45) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q)
    let b0, b1, b2
    if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0 }
    else if (type === "hp") { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0 }
    else { b0 = al; b1 = 0; b2 = -al }
    const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}
const env = (len: number, attack: number, decay: number) => Float64Array.from({ length: len }, (_, i) => {
  const t = i / SR
  return (attack > 0 ? Math.min(1, t / attack) : 1) * Math.exp(-Math.max(0, t - attack) / decay)
})
const mul = (a: Float64Array, b: Float64Array) => a.map((v, i) => v * b[i])
const add = (...xs: Array<[Float64Array, number]>) => {
  const len = Math.max(...xs.map(([x]) => x.length))
  const y = new Float64Array(len)
  for (const [x, g] of xs) for (let i = 0; i < x.length; i++) y[i] += x[i] * g
  return y
}
const sat = (x: Float64Array, drive: number) => x.map((v) => Math.tanh(v * drive) / Math.tanh(drive))
const fadeOut = (x: Float64Array, sec: number) => { const k = n(sec); for (let i = 0; i < k; i++) x[x.length - 1 - i] *= i / k; return x }
const sineSweep = (len: number, freq: (t: number) => number) => { let ph = 0; return Float64Array.from({ length: len }, (_, i) => { ph += 2 * Math.PI * freq(i / SR) / SR; return Math.sin(ph) }) }
const square = (len: number, f: number) => Float64Array.from({ length: len }, (_, i) => Math.sin(2 * Math.PI * f * i / SR) >= 0 ? 1 : -1)

const write = (name: string, left: Float64Array, right = left, peakDb = -3) => {
  const peak = Math.max(...left.map(Math.abs), ...right.map(Math.abs)) || 1
  const gain = 10 ** (peakDb / 20) / peak
  const frames = left.length
  const buf = Buffer.alloc(44 + frames * 6)
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * 6, 4); buf.write("WAVE", 8); buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 6, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34); buf.write("data", 36); buf.writeUInt32LE(frames * 6, 40)
  for (let i = 0; i < frames; i++) for (const [c, x] of [left, right].entries()) {
    const v = Math.max(-8388608, Math.min(8388607, Math.round(x[i] * gain * 8388607)))
    buf.writeIntLE(v, 44 + i * 6 + c * 3, 3)
  }
  writeFileSync(`${out}/${name}.wav`, buf)
}

// Kick: pitch-swept sine with a short click, gently saturated.
{
  const len = n(0.6)
  const body = mul(sineSweep(len, (t) => 47 + 118 * Math.exp(-t / 0.038)), env(len, 0.001, 0.34))
  const click = mul(biquad("bp", 3200, 0.9)(noise(len)), env(len, 0, 0.004))
  write("kick", fadeOut(sat(add([body, 1], [click, 0.35]), 1.6), 0.03))
}
// Snare: two tuned body modes and band-limited noise.
{
  const len = n(0.42)
  const body = add([mul(sineSweep(len, (t) => 190 + 30 * Math.exp(-t / 0.01)), env(len, 0, 0.07)), 1], [mul(sineSweep(len, () => 335), env(len, 0, 0.045)), 0.5])
  const wires = mul(biquad("lp", 9000, 0.7)(biquad("hp", 1600, 0.7)(noise(len))), env(len, 0.001, 0.15))
  write("snare", fadeOut(sat(add([body, 0.7], [wires, 0.9]), 1.3), 0.03))
}
// Clap: three short bursts and a tail through a band-pass.
{
  const len = n(0.5)
  const shape = Float64Array.from({ length: len }, (_, i) => {
    const t = i / SR
    const bursts = [0, 0.011, 0.023].reduce((s, at) => s + (t >= at ? Math.exp(-(t - at) / 0.005) : 0), 0)
    return bursts + (t >= 0.031 ? 0.85 * Math.exp(-(t - 0.031) / 0.13) : 0)
  })
  const l = mul(biquad("bp", 1250, 0.9)(noise(len)), shape), r = mul(biquad("bp", 1350, 0.9)(noise(len)), shape)
  write("clap", fadeOut(l, 0.04), fadeOut(r, 0.04))
}
// Hats: six detuned square partials (808-style metal) high-passed, plus noise.
const metal = (len: number) => add(...[263, 400, 421, 474, 587, 845].map((f): [Float64Array, number] => [square(len, f * 1.6), 1 / 6]))
{
  const len = n(0.12)
  const x = biquad("hp", 7500, 0.8)(add([metal(len), 0.6], [noise(len), 0.5]))
  write("hat", fadeOut(mul(x, env(len, 0.0005, 0.032)), 0.01), undefined, -4)
  const lenO = n(0.6)
  const o = biquad("hp", 7000, 0.8)(add([metal(lenO), 0.6], [noise(lenO), 0.5]))
  write("ohat", fadeOut(mul(o, env(lenO, 0.001, 0.22)), 0.05), undefined, -4)
}
// Shaker: band-passed noise with a soft attack.
{
  const len = n(0.14)
  const sh = (_: number) => mul(biquad("bp", 6500, 1.2)(noise(len)), env(len, 0.007, 0.035))
  write("shaker", fadeOut(sh(0), 0.01), fadeOut(sh(1), 0.01), -5)
}
// Rim tick.
{
  const len = n(0.08)
  const x = add([mul(sineSweep(len, () => 1700), env(len, 0, 0.012)), 1], [mul(sineSweep(len, () => 820), env(len, 0, 0.02)), 0.6], [mul(biquad("hp", 3000, 0.7)(noise(len)), env(len, 0, 0.004)), 0.4])
  write("rim", fadeOut(x, 0.01), undefined, -4)
}
// Crash: long metallic noise wash, decorrelated left and right.
{
  const len = n(2.2)
  const cr = () => mul(biquad("hp", 4200, 0.6)(add([metal(len), 0.35], [noise(len), 0.8])), env(len, 0.002, 0.65))
  write("crash", fadeOut(cr(), 0.3), fadeOut(cr(), 0.3), -5)
}
// Risers: noise through a rising band-pass with a rising tone, swelling to the end.
const riser = (sec: number) => {
  const len = n(sec)
  const sweep = (i: number) => 350 * (8500 / 350) ** ((i / len) ** 1.6)
  const swell = Float64Array.from({ length: len }, (_, i) => (i / len) ** 2.2)
  const mk = () => add([mul(biquad("bp", sweep, 2.2)(noise(len)), swell), 1], [mul(sineSweep(len, (t) => 220 * 2 ** (2 * t / sec)), swell), 0.12])
  const l = mk(), r = mk(); for (const x of [l, r]) for (let k = 0; k < n(0.01); k++) x[len - 1 - k] *= k / n(0.01)
  return [l, r] as const
}
write("riser-long", ...riser(3.4), -4)
write("riser-short", ...riser(1.0), -4)
// Reverse swell: a reversed crash.
{
  const len = n(1.5)
  const cr = () => mul(biquad("hp", 2500, 0.6)(noise(len)), env(len, 0.002, 0.45)).reverse()
  write("swell", cr(), cr(), -5)
}
// Impact: a deep pitched boom, a noise hit, and a filtered tail.
{
  const len = n(3)
  const boom = mul(sineSweep(len, (t) => 34 + 60 * Math.exp(-t / 0.08)), env(len, 0.002, 0.9))
  const hit = mul(biquad("lp", 2500, 0.7)(noise(len)), env(len, 0, 0.05))
  const tailL = mul(biquad("lp", 900, 0.7)(noise(len)), env(len, 0.02, 0.8)), tailR = mul(biquad("lp", 900, 0.7)(noise(len)), env(len, 0.02, 0.8))
  write("impact", fadeOut(sat(add([boom, 1], [hit, 0.5], [tailL, 0.25]), 1.4), 0.3), fadeOut(sat(add([boom, 1], [hit, 0.5], [tailR, 0.25]), 1.4), 0.3))
}
// Bell at C5: inharmonic additive partials with partial-dependent decay.
{
  const len = n(3), f0 = 523.25
  const partials: Array<[number, number, number]> = [[1, 1, 1.9], [2.0, 0.42, 1.1], [3.01, 0.22, 0.7], [4.16, 0.14, 0.45], [5.43, 0.08, 0.28], [0.5, 0.12, 2.4]]
  const x = add(...partials.map(([ratio, amp, decay]): [Float64Array, number] => [mul(sineSweep(len, () => f0 * ratio), env(len, 0.002, decay)), amp]))
  write("bell", fadeOut(x, 0.2))
}
console.log("ok")
