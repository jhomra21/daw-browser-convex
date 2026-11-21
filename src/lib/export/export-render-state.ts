import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown"
import { type AutomationEnvelope, automationEnvelopeFromRow, isLocalId } from '@daw-browser/shared'
import { captureLocalExportRenderRowsSnapshot } from '~/lib/export/capture-local-export-render-rows'
import { applyEffectsProjectionToFx, applyLocalEffectRowsToFx, applyRoomEffectRowsToFx, cloneAutomationEnvelope, cloneExportFx, type ExportAutomationPatch, type ExportCloudRenderRowsSnapshot, type ExportRenderStateSnapshot } from '~/lib/desired-playback-state'
import type { ExportEffectsProjection } from '~/lib/export/export-effect-rows'
import { listLocalExternalProcessors } from '~/lib/external-plugins'
import { getLocalProject } from '~/lib/local-project-db'
import { assertBrowserExportHasNoLiveExternalPlugins } from '@daw-browser/external-plugins'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'

const applyAutomationPatches = (
  envelopes: readonly AutomationEnvelope[],
  patches: readonly ExportAutomationPatch[] | undefined,
) => {
  if (!patches || patches.length === 0) return envelopes.map(cloneAutomationEnvelope)
  const merged = new Map(envelopes.map((envelope) => [envelope.targetKey, envelope]))

  for (const patch of patches) {
    if (patch.envelope) merged.set(patch.targetKey, cloneAutomationEnvelope(patch.envelope))
    else merged.delete(patch.targetKey)
  }

  return Array.from(merged.values(), cloneAutomationEnvelope)
}

const createExportFx = (masterVolume: number): ExportFx => ({
  trackFx: {},
  masterFxInstances: [],
  masterVolume,
})

type ExportExternalPluginPolicy = 'browser-export' | 'native-playback' | 'native-offline'

export const createExportRenderStateSnapshot = async (input: {
  projectId: string | undefined
  userId: string | undefined
  masterVolume: number
  cloudRows: ExportCloudRenderRowsSnapshot | undefined
  effectsProjection?: ExportEffectsProjection
  automationPatches?: readonly ExportAutomationPatch[]
  externalPluginPolicy?: ExportExternalPluginPolicy
}): Promise<ExportRenderStateSnapshot> => {
  const {
    projectId,
    userId,
    masterVolume,
    cloudRows,
    effectsProjection,
    automationPatches,
    externalPluginPolicy = 'browser-export',
  } = input

  const fx = createExportFx(masterVolume)
  const localOnly = projectId ? isLocalId('project', projectId) || await getLocalProject(projectId) !== undefined : false

  if (localOnly && projectId) {
    // Playback reads the effects draft without draining its preparation-dependent owner. The only rows read are effects and
    // automation envelopes; the other pending-write kinds and the timeline writes never write those rows, and an automation
    // edit in flight is in `automationPatches` until it persists. So a projected playback capture flushes nothing.
    if (externalPluginPolicy !== 'native-playback' || !effectsProjection) {
      await flushLocalProjectPendingWrites(projectId)
    }

    const rows = await captureLocalExportRenderRowsSnapshot(projectId)

    if (externalPluginPolicy === 'browser-export') {
      assertBrowserExportHasNoLiveExternalPlugins(await listLocalExternalProcessors(projectId))
    }

    applyLocalEffectRowsToFx(fx, rows.effects)
    applyEffectsProjectionToFx(fx, effectsProjection)

    return {
      fx: cloneExportFx(fx),
      automationEnvelopes: applyAutomationPatches(rows.automationEnvelopes, automationPatches),
    }
  }

  if (!localOnly && projectId && userId) {
    if (!cloudRows) throw new Error('Cloud timeline snapshot is unavailable.')
    applyRoomEffectRowsToFx(fx, cloudRows.effects)
    applyEffectsProjectionToFx(fx, effectsProjection)

    return {
      fx: cloneExportFx(fx),
      automationEnvelopes: applyAutomationPatches(cloudRows.automationEnvelopes.flatMap((row) => {
        const envelope = automationEnvelopeFromRow(row)

        return envelope ? [envelope] : []
      }), automationPatches),
    }
  }

  return { fx: cloneExportFx(fx), automationEnvelopes: [] }
}
