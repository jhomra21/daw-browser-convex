import { expect, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { AUDIO_EFFECT_KINDS, buildEffectParamsOperation, normalizeAudioEffectRow, type AudioEffectKind, type JsonValue } from '@daw-browser/shared'

import { executeTimelineOperation } from './timeline-operation-executor'

// The convex mutation each kind's params operation reaches, and whether the executor names the kind in the arguments.
const mutationByKind = {
  utility: { name: 'Processor', effect: true },
  eq: { name: 'Eq', effect: false },
  autofilter: { name: 'Modulation', effect: true },
  gate: { name: 'Processor', effect: true },
  compressor: { name: 'Compressor', effect: false },
  saturator: { name: 'Saturator', effect: false },
  limiter: { name: 'Processor', effect: true },
  lofi: { name: 'Modulation', effect: true },
  chorus: { name: 'Modulation', effect: true },
  flanger: { name: 'Modulation', effect: true },
  phaser: { name: 'Modulation', effect: true },
  tremolo: { name: 'Modulation', effect: true },
  autopan: { name: 'Modulation', effect: true },
  ensemble: { name: 'Modulation', effect: true },
  delay: { name: 'Delay', effect: false },
  reverb: { name: 'Reverb', effect: false },
  spectral: { name: 'Processor', effect: true },
  spectrum: { name: 'Modulation', effect: true },
} as const satisfies Record<AudioEffectKind, { name: string; effect: boolean }>

type MutationArgs = { projectId: string; trackId?: string; effect?: string; instanceId: string; params: JsonValue }

const run = async (kind: AudioEffectKind, trackId?: string) => {
  const row = normalizeAudioEffectRow(kind, {})
  const calls: { name: string; args: MutationArgs }[] = []

  await executeTimelineOperation({
    projectId: 'project-1',
    convex: {
      query: async () => ({ tracks: [{ _id: 'track-1' }], clips: [] }),
      mutation: async (reference: Parameters<typeof getFunctionName>[0], args: MutationArgs) => {
        calls.push({ name: getFunctionName(reference), args })

        return { status: 'applied' }
      },
    },
  }, buildEffectParamsOperation(row, 'instance-1', trackId))

  return { row, calls }
}

for (const kind of AUDIO_EFFECT_KINDS) {
  test(`${kind} params reach their convex mutation on a track and on the master`, async () => {
    const { name, effect } = mutationByKind[kind]
    const track = await run(kind, 'track-1')
    const master = await run(kind)

    const trackArgs = effect
      ? { projectId: 'project-1', trackId: 'track-1', effect: kind, instanceId: 'instance-1', params: track.row.params }
      : { projectId: 'project-1', trackId: 'track-1', instanceId: 'instance-1', params: track.row.params }

    const masterArgs = effect
      ? { projectId: 'project-1', effect: kind, instanceId: 'instance-1', params: master.row.params }
      : { projectId: 'project-1', instanceId: 'instance-1', params: master.row.params }

    expect(track.calls).toEqual([{ name: `effects:serverSet${name}Params`, args: trackArgs }])
    expect(master.calls).toEqual([{ name: `effects:serverSetMaster${name}Params`, args: masterArgs }])
  })
}
