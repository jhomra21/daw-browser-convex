import { afterEach, describe, expect, test } from "bun:test"
import { AudioEngine } from "./audio-engine"

const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const stream = Object.assign(Object.create(null), {
  getAudioTracks: () => [],
})

const installAudioContext = (resume: () => Promise<void>, setSinkId: () => Promise<void>) => {
  class FakeAudioContext extends EventTarget {
    readonly destination = {}
    readonly sampleRate = 48_000
    readonly baseLatency = 0
    readonly outputLatency = 0
    readonly currentTime = 0
    readonly state = "suspended"
    readonly createGain = () => ({
      gain: {
        value: 1,
        cancelScheduledValues: () => {},
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
      connect: () => {},
      disconnect: () => {},
    })
    readonly resume = resume
    readonly setSinkId = setSinkId
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "AudioContext")
})

describe("AudioEngine recording calibration reservation", () => {
  test("blocks calibration while recording startup is reserved", async () => {
    const engine = new AudioEngine()
    const recording = engine.startRecordingCapture(Object.create(null))
    await expect(engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: new AbortController().signal,
    })).rejects.toThrow("Stop recording")
    await expect(recording).rejects.toThrow()
  })

  test("blocks concurrent calibration, recording, and playback before the first await", async () => {
    const resume = deferred()
    installAudioContext(() => resume.promise, () => Promise.resolve())
    const engine = new AudioEngine()
    const controller = new AbortController()
    const calibration = engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: controller.signal,
    })

    expect(engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: new AbortController().signal,
    })).rejects.toThrow("already running")
    expect(() => engine.startRecordingCapture(Object.create(null))).toThrow("calibration")
    expect(() => engine.onTransportStart(0)).toThrow("calibration")

    controller.abort()
    resume.resolve()
    expect(calibration).rejects.toMatchObject({ name: "AbortError" })
  })

  test("releases the reservation when aborted during resume", async () => {
    const resume = deferred()
    installAudioContext(() => resume.promise, () => Promise.resolve())
    const engine = new AudioEngine()
    const controller = new AbortController()
    const calibration = engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: controller.signal,
    })

    controller.abort()
    resume.resolve()
    await expect(calibration).rejects.toMatchObject({ name: "AbortError" })
    await expect(engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: "AbortError" })
  })

  test("releases the reservation when aborted during output selection", async () => {
    const output = deferred()
    installAudioContext(() => Promise.resolve(), () => output.promise)
    const engine = new AudioEngine()
    const controller = new AbortController()
    const calibration = engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: controller.signal,
    })

    await Promise.resolve()
    controller.abort()
    output.resolve()
    await expect(calibration).rejects.toMatchObject({ name: "AbortError" })
    await expect(engine.calibrateRecording({
      stream,
      inputDeviceId: "input",
      outputDeviceId: "output",
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: "AbortError" })
  })
})
