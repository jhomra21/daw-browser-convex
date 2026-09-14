import { describe, expect, test } from 'bun:test'

import { getAudioClipTimeMap, getMarkerWarpTimelineSegments } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'
import { drawWaveformPcmLine, drawWaveformPeaks } from '@daw-browser/waveforms/render-waveform'
import { selectWaveformLod } from '@daw-browser/waveforms/lod'
import { createPcmSampleWindowCollector } from '@daw-browser/waveforms/pcm-samples'
import type { WaveformPcmResult } from '@daw-browser/waveforms/types'
import {
  getAudioWaveformLayout,
  type AudioWaveformLayoutSegment,
} from './audio-waveform-layout'
import { createWaveformRequestPlans, projectRetainedWaveformData } from './retained-waveform'

type WaveformLodCase = {
  name: string
  pixelsPerSecond: number
  mode: 'cached-peaks' | 'pcm-envelope' | 'pcm-line'
}

type TimingCase = {
  name: string
  projectBpm: number
  sourceDurationSec: number
  clip: Partial<Clip<AudioBuffer>>
}

const createClip = (input: Partial<Clip<AudioBuffer>> = {}): Clip<AudioBuffer> => ({
  id: 'canonical-waveform-timing',
  name: 'canonical-waveform-timing',
  startSec: 10,
  duration: 4,
  sourceDurationSec: 4,
  color: '#fff',
  ...input,
})

const timingCases: TimingCase[] = [
  {
    name: 'normal',
    projectBpm: 120,
    sourceDurationSec: 4,
    clip: {},
  },
  {
    name: 'trim buffer offset and left pad',
    projectBpm: 120,
    sourceDurationSec: 8,
    clip: {
      duration: 2.5,
      sourceDurationSec: 8,
      bufferOffsetSec: 1.25,
      leftPadSec: 0.5,
    },
  },
  {
    name: 're-pitch',
    projectBpm: 120,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
    },
  },
  {
    name: 're-pitch source 120 bpm to project 90 bpm',
    projectBpm: 90,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
    },
  },
  {
    name: 're-pitch source 120 bpm to project 120 bpm',
    projectBpm: 120,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
    },
  },
  {
    name: 're-pitch source 120 bpm to project 150 bpm',
    projectBpm: 150,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
    },
  },
  {
    name: 'stretch',
    projectBpm: 120,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 100 },
    },
  },
  {
    name: 'marker warp with two local slopes',
    projectBpm: 120,
    sourceDurationSec: 4,
    clip: {
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', sourceBeat: 0, timelineBeat: 0 },
          { id: 'b', sourceBeat: 1, timelineBeat: 2 },
          { id: 'c', sourceBeat: 3, timelineBeat: 3 },
          { id: 'd', sourceBeat: 6, timelineBeat: 6 },
        ],
      },
    },
  },
  {
    name: 'source beat offset',
    projectBpm: 120,
    sourceDurationSec: 8,
    clip: {
      sourceDurationSec: 8,
      audioWarp: {
        enabled: true,
        mode: 'repitch',
        sourceBpm: 120,
        sourceBeatOffset: 1,
      },
    },
  },
  {
    name: 'trim offset warp source 120 bpm to project 90 bpm',
    projectBpm: 90,
    sourceDurationSec: 10,
    clip: {
      duration: 3,
      sourceDurationSec: 10,
      bufferOffsetSec: 2,
      leftPadSec: 0.25,
      audioWarp: {
        enabled: true,
        mode: 'repitch',
        sourceBpm: 120,
        sourceBeatOffset: 0.5,
      },
    },
  },
]

const mapFor = (clip: Clip<AudioBuffer>, projectBpm: number, sourceDurationSec: number) => {
  const map = getAudioClipTimeMap({
    clip,
    bufferDurationSec: sourceDurationSec,
    projectBpm,
    rangeStartSec: clip.startSec,
    rangeEndSec: clip.startSec + clip.duration,
  })
  if (!map) throw new Error(`Expected a timing map for ${clip.id}.`)
  return map
}

const screenX = (input: {
  map: ReturnType<typeof mapFor>
  sourceFrame: number
  sampleRate: number
  visibleStartSec: number
  pixelsPerSecond: number
}) => (
  (input.map.sourceToTimelineSec(input.sourceFrame / input.sampleRate) - input.visibleStartSec)
    * input.pixelsPerSecond
)

const sourceFrameProbes = (input: {
  map: ReturnType<typeof mapFor>
  sampleRate: number
  markers?: readonly { sourceBeat: number }[]
  sourceBpm: number
}) => {
  const firstFrame = Math.ceil(input.map.sourceStartSec * input.sampleRate)
  const exclusiveEndFrame = Math.ceil(input.map.sourceEndSec * input.sampleRate)
  const firstTileBoundary = Math.max(
    16_384,
    Math.ceil(firstFrame / 16_384) * 16_384,
  )
  const frames = new Set([
    firstFrame,
    firstFrame + 1,
    Math.floor((firstFrame + exclusiveEndFrame - 1) / 2),
    firstTileBoundary - 1,
    firstTileBoundary,
    firstTileBoundary + 1,
    exclusiveEndFrame - 2,
    exclusiveEndFrame - 1,
  ])
  for (const marker of input.markers ?? []) {
    const markerFrame = Math.round(
      marker.sourceBeat * 60 * input.sampleRate / input.sourceBpm,
    )
    frames.add(markerFrame - 1)
    frames.add(markerFrame)
    frames.add(markerFrame + 1)
  }
  return [...frames].filter((frame) => (
    frame >= firstFrame && frame < exclusiveEndFrame
  ))
}

describe('canonical audio clip waveform timing', () => {
  test('maps included frames and interval boundaries for every timing mode and sample rate', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const timingCase of timingCases) {
        const clip = createClip(timingCase.clip)
        const map = mapFor(clip, timingCase.projectBpm, timingCase.sourceDurationSec)
        const sourceBpm = clip.audioWarp?.sourceBpm ?? timingCase.projectBpm
        const frames = sourceFrameProbes({
          map,
          sampleRate,
          markers: clip.audioWarp?.markers,
          sourceBpm,
        })
        const visibleStartSec = map.timelineStartSec
        const pixelsPerSecond = 1_000
        expect(frames.length).toBeGreaterThan(0)

        for (const sourceFrame of frames) {
          const sourceSec = sourceFrame / sampleRate
          const timelineSec = map.sourceToTimelineSec(sourceSec)
          expect(map.timelineToSourceSec(timelineSec)).toBeCloseTo(sourceSec, 10)
          expect(screenX({
            map,
            sourceFrame,
            sampleRate,
            visibleStartSec,
            pixelsPerSecond,
          })).toBeCloseTo(
            (timelineSec - visibleStartSec) * pixelsPerSecond,
            10,
          )
        }
        expect(map.sourceToTimelineSec(map.sourceEndSec)).toBeCloseTo(map.timelineEndSec, 10)

        const cssWidth = Math.max(1, Math.ceil(map.timelineDurationSec * pixelsPerSecond))
        const layout = getAudioWaveformLayout(
          clip,
          cssWidth,
          timingCase.sourceDurationSec,
          timingCase.projectBpm,
          { startSec: map.timelineStartSec, endSec: map.timelineEndSec },
        )
        expect(layout.sourceStartSec).toBeCloseTo(map.sourceStartSec, 8)
        expect(layout.sourceEndSec).toBeCloseTo(map.sourceEndSec, 8)
        expect(layout.drawCols).toBeGreaterThan(0)
        const firstFrame = Math.floor(map.sourceStartSec * sampleRate)
        const endFrame = Math.ceil(map.sourceEndSec * sampleRate)
        const samples = new Float32Array(endFrame - firstFrame)
        for (const sourceFrame of frames) samples[sourceFrame - firstFrame] = 1
        const retained: WaveformPcmResult = {
          mode: 'pcm-line',
          channels: [samples],
          firstFrame,
          sampleRate,
          sourceStartSec: firstFrame / sampleRate,
          sourceEndSec: endFrame / sampleRate,
        }
        const segments = layout.segments ?? [{
          drawCols: layout.drawCols,
          sourceStartSec: layout.sourceStartSec,
          sourceEndSec: layout.sourceEndSec,
          startPx: layout.padPx,
          endPx: layout.audioEndPx,
          canvasStartSec: layout.canvasStartSec ?? map.timelineStartSec,
          canvasEndSec: layout.canvasEndSec ?? map.timelineEndSec,
        }]
        const projected = projectRetainedWaveformData({
          retainedByKey: new Map([['timing', {
            data: retained,
            sourceStartSec: retained.sourceStartSec,
            sourceEndSec: retained.sourceEndSec,
          }]]),
          segments: segments.map((segment) => ({ requestKey: 'timing', segment })),
          map,
        })
        for (const sourceFrame of frames) {
          const sourceSec = sourceFrame / sampleRate
          const item = projected.find((candidate) => (
            sourceSec >= candidate.sourceStartSec
            && sourceSec < candidate.sourceEndSec
          ))
          if (!item) throw new Error(`Missing projected frame for ${timingCase.name}.`)
          if (item.data.mode !== 'pcm-line') throw new Error('Expected raw PCM projection.')
          expect(item.data.channels[0]?.[sourceFrame - item.data.firstFrame]).toBe(1)
          const projectedX = item.startPx + (
            (map.sourceToTimelineSec(sourceSec) - item.canvasStartSec)
            / Math.max(1e-9, item.canvasEndSec - item.canvasStartSec)
          ) * (item.endPx - item.startPx)
          const expectedX = screenX({
            map,
            sourceFrame,
            sampleRate,
            visibleStartSec: map.timelineStartSec,
            pixelsPerSecond,
          })
          expect(Math.abs(projectedX - expectedX)).toBeLessThanOrEqual(0.5)
        }
      }
    }
  })

  test('keeps cached peak and PCM envelope intervals half-open at exact boundaries', () => {
    const clip = createClip({ startSec: 0, duration: 1, sourceDurationSec: 1 })
    const map = mapFor(clip, 120, 1)
    const intervalSegments: AudioWaveformLayoutSegment[] = [
      {
        drawCols: 100,
        sourceStartSec: 0,
        sourceEndSec: 0.5,
        startPx: 0,
        endPx: 50,
        canvasStartSec: 0,
        canvasEndSec: 0.5,
      },
      {
        drawCols: 100,
        sourceStartSec: 0.5,
        sourceEndSec: 1,
        startPx: 50,
        endPx: 100,
        canvasStartSec: 0.5,
        canvasEndSec: 1,
      },
    ]
    const dataFor = (sourceStartSec: number, sourceEndSec: number): WaveformPcmResult => ({
      mode: 'pcm-envelope',
      columns: 1,
      channels: [new Uint8Array([128, 255])],
      sourceStartSec,
      sourceEndSec,
    })
    const projected = projectRetainedWaveformData({
      retainedByKey: new Map([
        ['left', { data: dataFor(0, 0.5), sourceStartSec: 0, sourceEndSec: 0.5 }],
        ['right', { data: dataFor(0.5, 1), sourceStartSec: 0.5, sourceEndSec: 1 }],
      ]),
      segments: intervalSegments.map((segment, index) => ({
        requestKey: index === 0 ? 'left' : 'right',
        segment,
      })),
      map,
    })

    expect(projected).toHaveLength(2)
    expect(projected[0]?.sourceStartSec).toBe(0)
    expect(projected[0]?.sourceEndSec).toBe(0.5)
    expect(projected[1]?.sourceStartSec).toBe(0.5)
    expect(projected[1]?.sourceEndSec).toBe(1)
    expect(projected[0]?.endPx).toBe(projected[1]?.startPx)
    expect(projected[0]?.endPx).toBe(screenX({
      map,
      sourceFrame: 0.5 * 48_000,
      sampleRate: 48_000,
      visibleStartSec: 0,
      pixelsPerSecond: 100,
    }))
    expect(projectRetainedWaveformData({
      retainedByKey: new Map([
        ['left', { data: dataFor(0, 0.5), sourceStartSec: 0, sourceEndSec: 0.5 }],
      ]),
      segments: [{
        requestKey: 'left',
        segment: {
          ...intervalSegments[0]!,
          sourceStartSec: 0.5,
          sourceEndSec: 0.5,
          canvasStartSec: 0.5,
          canvasEndSec: 0.5,
        },
      }],
      map,
    })).toHaveLength(0)
  })

  test('owns marker boundaries once while projecting marker-warp intervals', () => {
    const clip = createClip({
      startSec: 0,
      duration: 4,
      sourceDurationSec: 4,
      audioWarp: {
        enabled: true,
        mode: 'stretch',
        sourceBpm: 120,
        markers: [
          { id: 'a', sourceBeat: 0, timelineBeat: 0 },
          { id: 'b', sourceBeat: 1, timelineBeat: 2 },
          { id: 'c', sourceBeat: 3, timelineBeat: 3 },
          { id: 'd', sourceBeat: 6, timelineBeat: 6 },
        ],
      },
    })
    const map = mapFor(clip, 120, 4)
    const canonical = getMarkerWarpTimelineSegments({
      clip,
      map,
      projectBpm: 120,
      timelineEndSec: map.timelineEndSec,
    })
    expect(canonical.length).toBeGreaterThanOrEqual(3)
    const projected = projectRetainedWaveformData({
      retainedByKey: new Map(canonical.map((segment, index) => {
        const data: WaveformPcmResult = {
          mode: 'pcm-envelope',
          columns: 1,
          channels: [new Uint8Array([128, 255])],
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
        }
        return [
          `marker-${index}`,
          {
            data,
            sourceStartSec: segment.sourceStartSec,
            sourceEndSec: segment.sourceEndSec,
          },
        ]
      })),
      segments: canonical.map((segment, index) => ({
        requestKey: `marker-${index}`,
        segment: {
          drawCols: Math.max(1, Math.ceil((segment.timelineEndSec - segment.timelineStartSec) * 100)),
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          startPx: (segment.timelineStartSec - map.timelineStartSec) * 100,
          endPx: (segment.timelineEndSec - map.timelineStartSec) * 100,
          canvasStartSec: segment.timelineStartSec,
          canvasEndSec: segment.timelineEndSec,
        },
      })),
      map,
    })
    expect(projected).toHaveLength(canonical.length)
    for (let index = 1; index < projected.length; index += 1) {
      expect(projected[index - 1]?.sourceEndSec).toBe(projected[index]?.sourceStartSec)
      expect(projected[index - 1]?.endPx).toBe(projected[index]?.startPx)
      expect(projected[index - 1]?.canvasEndSec).toBe(projected[index]?.canvasStartSec)
    }
    for (let index = 1; index < projected.length; index += 1) {
      const boundary = projected[index - 1]?.sourceEndSec
      expect(projected.filter((item) => (
        boundary !== undefined
        && boundary >= item.sourceStartSec
        && boundary < item.sourceEndSec
      ))).toHaveLength(1)
    }
  })

  test('selects and projects all four visual LOD contracts at exact source positions', () => {
    const sampleRate = 48_000
    const clip = createClip({
      startSec: 0,
      duration: 1,
      sourceDurationSec: 1,
      sourceSampleRate: sampleRate,
      sourceChannelCount: 1,
    })
    const map = mapFor(clip, 120, 1)
    const lodCases: WaveformLodCase[] = [
      { name: 'cached peaks', pixelsPerSecond: 400, mode: 'cached-peaks' },
      { name: 'PCM envelope', pixelsPerSecond: 10_000, mode: 'pcm-envelope' },
      { name: 'raw PCM line', pixelsPerSecond: 120_000, mode: 'pcm-line' },
      { name: 'sample points', pixelsPerSecond: 240_000, mode: 'pcm-line' },
    ]

    for (const lodCase of lodCases) {
      const layout = getAudioWaveformLayout(
        clip,
        lodCase.pixelsPerSecond,
        1,
        120,
        { startSec: map.timelineStartSec, endSec: map.timelineEndSec },
      )
      const displaySegment = layout.segments?.[0] ?? {
        drawCols: layout.drawCols,
        sourceStartSec: layout.sourceStartSec,
        sourceEndSec: layout.sourceEndSec,
        startPx: layout.padPx,
        endPx: layout.audioEndPx,
        canvasStartSec: map.timelineStartSec,
        canvasEndSec: map.timelineEndSec,
      }
      const plans = createWaveformRequestPlans({
        segments: [displaySegment],
        sampleRate,
        sourceDurationSec: 1,
        sampleDetail: false,
      })
      const request = plans.requests[0]
      if (!request) throw new Error(`Expected a request for ${lodCase.name}.`)
      expect(selectWaveformLod({
        sampleRate,
        sourceStartSec: displaySegment.sourceStartSec,
        sourceEndSec: displaySegment.sourceEndSec,
        widthPx: displaySegment.drawCols,
      })?.mode).toBe(lodCase.mode)
      expect(request.lod.mode).toBe(lodCase.mode)

      if (lodCase.mode === 'pcm-line') {
        const collector = createPcmSampleWindowCollector({
          startFrame: 0,
          endFrame: sampleRate,
          sampleRate,
          channelCount: 1,
          sourceStartSec: 0,
          sourceEndSec: 1,
        })
        const samples = new Float32Array(sampleRate)
        samples[16_384] = 1
        collector.append({
          startFrame: 0,
          frameCount: sampleRate,
          sampleRate,
          channelCount: 1,
          planes: [samples],
        })
        const data = collector.finish()
        expect(data.firstFrame).toBe(0)
        expect(data.channels[0]).toHaveLength(sampleRate)
        expect(data.channels[0]?.[16_384]).toBe(1)
        const projected = projectRetainedWaveformData({
          retainedByKey: new Map([[request.key, {
            data,
            sourceStartSec: data.sourceStartSec,
            sourceEndSec: data.sourceEndSec,
          }]]),
          segments: plans.segments,
          map,
        })
        const item = projected[0]
        if (!item || item.data.mode !== 'pcm-line') throw new Error('Expected raw PCM projection.')
        const xValues: number[] = []
        let points = 0
        drawWaveformPcmLine({
          ctx: {
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            beginPath() {},
            moveTo(x) { xValues.push(x) },
            lineTo(x) { xValues.push(x) },
            stroke() {},
            fillRect() {},
            globalAlpha: 1,
            arc() { points += 1 },
            fill() {},
          },
          pcm: item.data,
          topY: 0,
          contentH: 100,
          cssW: item.endPx - item.startPx,
          xOffsetPx: item.startPx,
          lineOpacity: 1,
          pointOpacity: lodCase.name === 'sample points' ? 1 : 0,
          pointRadius: 1,
        })
        const expectedX = screenX({
          map,
          sourceFrame: 16_384,
          sampleRate,
          visibleStartSec: map.timelineStartSec,
          pixelsPerSecond: lodCase.pixelsPerSecond,
        })
        expect(xValues[16_384]).toBeCloseTo(expectedX, 5)
        expect(Math.abs((xValues[16_384] ?? 0) - expectedX)).toBeLessThanOrEqual(0.5)
        for (const sourceFrame of [0, 1, 16_383, 16_384, sampleRate - 1]) {
          expect(xValues[sourceFrame]).toBeCloseTo(screenX({
            map,
            sourceFrame,
            sampleRate,
            visibleStartSec: map.timelineStartSec,
            pixelsPerSecond: lodCase.pixelsPerSecond,
          }), 5)
        }
        expect(points).toBe(lodCase.name === 'sample points' ? sampleRate : 0)
      } else {
        const data: WaveformPcmResult = {
          mode: 'pcm-envelope',
          columns: 1,
          channels: [new Uint8Array([128, 255])],
          sourceStartSec: displaySegment.sourceStartSec,
          sourceEndSec: displaySegment.sourceEndSec,
        }
        const projected = projectRetainedWaveformData({
          retainedByKey: new Map([[request.key, {
            data,
            sourceStartSec: data.sourceStartSec,
            sourceEndSec: data.sourceEndSec,
          }]]),
          segments: plans.segments,
          map,
        })
        expect(projected).toHaveLength(1)
        expect(projected[0]?.sourceStartSec).toBe(displaySegment.sourceStartSec)
        expect(projected[0]?.sourceEndSec).toBe(displaySegment.sourceEndSec)
        expect(projected[0]?.startPx).toBe(displaySegment.startPx)
        expect(projected[0]?.endPx).toBe(displaySegment.endPx)
        let renderedColumns = 0
        drawWaveformPeaks({
          ctx: {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            fillRect() { renderedColumns += 1 },
          },
          peaks: data.channels[0] ?? new Uint8Array(),
          drawCols: Math.max(1, Math.ceil(projected[0]?.endPx ?? 0)),
          padPx: 0,
          topY: 0,
          contentH: 100,
          cssW: Math.max(1, Math.ceil(projected[0]?.endPx ?? 0)),
          cssH: 100,
        })
        expect(renderedColumns).toBeGreaterThan(0)
      }
    }
  })
})
