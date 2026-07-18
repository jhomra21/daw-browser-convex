import { expect, test } from "bun:test"
import { preflightExportResources } from "~/lib/export/export-resource-preflight"
import type { ExportEncodingSettings, ExportRenderSettings } from "~/lib/export/export-settings"

const render: ExportRenderSettings = {
  sampleRate: 44_100,
  numberOfChannels: 2,
  normalization: { mode: "none" },
  tail: { mode: "none" },
}
const encoding: ExportEncodingSettings = {
  bitrateByFormat: {},
  wav: { codec: "pcm-s16", dither: "none" },
}
const tracks = [{ clips: [{ startSec: 0, duration: 1 }] }]
const desktopLimits = {
  maximumFiles: 1_024,
  maximumBytes: 8 * 1024 * 1024 * 1024,
  streaming: true as const,
}

test("desktop preflight accepts 1024 outputs and rejects 1025", () => {
  expect(preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["wav"],
    render,
    encoding,
    stemCount: 1_024,
    resourceLimits: desktopLimits,
  }).outputCount).toBe(1_024)
  expect(() => preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["wav"],
    render,
    encoding,
    stemCount: 1_025,
    resourceLimits: desktopLimits,
  })).toThrow("1024")
})

test("browser preflight retains output behavior without desktop constraints", () => {
  expect(preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["wav"],
    render,
    encoding,
    stemCount: 1_025,
  }).outputCount).toBe(1_025)
})

test("preflight accounts for tail and conservative aggregate bytes", () => {
  const result = preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["wav", "flac"],
    render: { ...render, tail: { mode: "fixed", durationSec: 2 } },
    encoding,
    stemCount: 1,
  })
  expect(result.renderEndSec).toBe(3)
  expect(result.aggregateBytes).toBeGreaterThan(0)
})

test("preflight rejects a RIFF WAV beyond four gibibytes", () => {
  expect(() => preflightExportResources({
    tracks: [{ clips: [{ startSec: 0, duration: 20_000 }] }],
    range: { mode: "whole" },
    formats: ["wav"],
    render: { ...render, sampleRate: 96_000 },
    encoding,
    stemCount: 1,
  })).toThrow("RIFF")
})

test("preflight accounts for the automatic tail maximum and unique formats", () => {
  const result = preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["mp3", "mp3", "ogg-opus"],
    render: {
      ...render,
      tail: { mode: "automatic", thresholdDbfs: -60, holdSec: 1, maximumSec: 12 },
    },
    encoding,
    stemCount: 3,
  })
  expect(result.renderEndSec).toBe(13)
  expect(result.outputCount).toBe(6)
})

test("desktop preflight rejects raw render buffers beyond the host envelope", () => {
  expect(() => preflightExportResources({
    tracks,
    range: { mode: "custom", startSec: 0, endSec: 12_000 },
    formats: ["mp3"],
    render: { ...render, sampleRate: 96_000 },
    encoding,
    stemCount: 1,
    resourceLimits: desktopLimits,
  })).toThrow("render buffer")
})

test("desktop preflight rejects a conservative aggregate output estimate", () => {
  expect(() => preflightExportResources({
    tracks,
    range: { mode: "whole" },
    formats: ["flac"],
    render,
    encoding,
    stemCount: 1_024,
    resourceLimits: desktopLimits,
  })).toThrow("desktop output")
})

test("lossy estimates use the selected bitrate metadata", () => {
  const low = preflightExportResources({
    tracks,
    range: { mode: "custom", startSec: 0, endSec: 600 },
    formats: ["mp3"],
    render,
    encoding: { ...encoding, bitrateByFormat: { mp3: 32_000 } },
    stemCount: 1,
  })
  const high = preflightExportResources({
    tracks,
    range: { mode: "custom", startSec: 0, endSec: 600 },
    formats: ["mp3"],
    render,
    encoding: { ...encoding, bitrateByFormat: { mp3: 320_000 } },
    stemCount: 1,
  })
  expect(high.aggregateBytes).toBeGreaterThan(low.aggregateBytes)
})
