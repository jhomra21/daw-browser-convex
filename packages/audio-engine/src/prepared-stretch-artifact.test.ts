import { expect, test } from 'bun:test'
import {
  createPreparedStretchArtifact,
  createPreparedStretchArtifactBinding,
} from './prepared-stretch-artifact'
import { createAudioStretchReadPlan } from './audio-stretch-read-plan'
import type { AudioPcmSourceDescriptor } from './media-pages'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'

const source: AudioPcmSourceDescriptor = {
  identity: 'session-source',
  contentHash: 'a'.repeat(64),
  contentHashVerified: true,
  persistable: true,
  durationSec: 1,
  frameCount: 100,
  sampleRate: 100,
  channelCount: 1,
  readPages: async function* () {},
}

const clip = (id: string, startSec = 0): AudioStretchRuntimeClip => ({
  id,
  startSec,
  duration: 1,
  audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
})

const artifactFor = (id: string, startSec = 0) => {
  const plan = createAudioStretchReadPlan({ clip: clip(id, startSec), source, projectBpm: 120 })
  return createPreparedStretchArtifact({
    source,
    plan,
    persistable: true,
    windowFrameCount: 2_048,
    overlapFrameCount: 1_024,
    searchFrameCount: 512,
  })
}

test('artifact identity excludes clip placement and generation-like identifiers', () => {
  const left = artifactFor('clip-a', 0)
  const right = artifactFor('clip-b', 4)
  expect(left.artifactId).toBe(right.artifactId)
  expect(left.artifactId).toMatch(/^stretch:v1:[0-9a-f]{64}$/)
  expect(createPreparedStretchArtifactBinding({
    clipId: 'clip-a',
    artifact: left,
    timelineStartSec: 4,
    timelineDurationSec: 1,
  })).toEqual({
    clipId: 'clip-a',
    artifactId: left.artifactId,
    timelineStartSec: 4,
    timelineDurationSec: 1,
    sourceStartSec: 0,
  })
})

test('artifact identity changes with source metadata, segments, and WSOLA configuration', () => {
  const baseline = artifactFor('clip-a')
  const changedConfig = createPreparedStretchArtifact({
    source,
    plan: createAudioStretchReadPlan({ clip: clip('clip-a'), source, projectBpm: 120 }),
    persistable: true,
    windowFrameCount: 1_024,
    overlapFrameCount: 512,
    searchFrameCount: 256,
  })
  const changedSource = createPreparedStretchArtifact({
    source: { ...source, contentHash: 'b'.repeat(64) },
    plan: createAudioStretchReadPlan({ clip: clip('clip-a'), source: { ...source, contentHash: 'b'.repeat(64) }, projectBpm: 120 }),
    persistable: true,
    windowFrameCount: 2_048,
    overlapFrameCount: 1_024,
    searchFrameCount: 512,
  })
  expect(changedConfig.artifactId).not.toBe(baseline.artifactId)
  expect(changedSource.artifactId).not.toBe(baseline.artifactId)
})
