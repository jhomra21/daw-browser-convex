import { createSourceAutomationScope, createStemRenderPlan } from "@daw-browser/audio-engine/export-stem-plan"
import { getExportRangeBounds, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportTailMaximumSec } from '@daw-browser/audio-engine/export-fidelity'
import { getExportAudioFormatMetadata, isLocalId, isLossyExportAudioFormat } from '@daw-browser/shared'
import { isAbortError } from '~/lib/dom-errors'
import { createUniqueStemFileName } from '~/lib/export/stem-file-names'
import { saveLocalExportMetadataBatch, type LocalExportMetadataInput } from '~/lib/local-export-metadata'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { isRenderableExportTrack } from '~/lib/export/export-settings'
import { processNativeOfflinePcmSpool } from '~/lib/export/process-native-offline-pcm-spool'
import { createNativeOfflinePcmSpool } from '~/lib/export/native-offline-pcm-spool'
import type { ExportOutputTargetFactory } from '~/lib/export/export-output-targets'
import { preflightExportResources } from '~/lib/export/export-resource-preflight'
import { cloneAutomationEnvelope, cloneExportFx } from '~/lib/desired-playback-state'
import { getLocalProject } from '~/lib/local-project-db'
import { compileNativeOfflineRenderPlan } from '~/lib/export/native-offline-render-plan'
import { NativeOfflineRenderError } from '~/lib/export/desktop-native-offline-pcm-renderer'
import type { NativeOfflinePcmSpoolSession } from '~/lib/export/native-offline-pcm-spool'
import { isPortableStretchClip } from '@daw-browser/audio-engine/portable-stretch-preparation'
import { prepareNativeStretchArtifacts, type NativePreparedStretchAsset } from '@daw-browser/audio-engine/native-stretch-preparation'
import { createAudioStretchCache } from '@daw-browser/audio-engine/audio-stretch-cache'
import { createPreparedStretchArtifactRepository, type PreparedStretchArtifactRepository } from '@daw-browser/audio-engine/prepared-stretch-store'
import { nativeInstrumentExportMemory, portableInstrumentExportMemory } from '~/lib/export/instrument-export-memory'
import type { NativeTimelinePageManager } from '~/lib/desktop/native-timeline-page-manager'
import { prepareNativeMappedSources } from '~/lib/export/export-native-sources'
import { type ExportFileCommit, type TimelineExportRequest, type StemExportSelection, type StemExportRequest, type ExportOutput, type ExportOutcome, NATIVE_EXPORT_UNAVAILABLE_MESSAGE } from '~/lib/export/export-job-types'
import { throwIfExportAborted, filterTracksToExportRange, ensureNativeStretchBuffers, loadInstrumentExportBuffers } from '~/lib/export/export-preparation'
import { createExportSeed, createEncodingProgressReporter, requireExportFormats, createMixdownFileName, createSaveTypes, reportFormatProgress, reportStemFormatProgress } from '~/lib/export/export-output-formats'










export const collectStemTracks = (input: StemExportSelection & { tracks: RuntimeTrack[] }): RuntimeTrack[] => {
  const matchesMode = (track: RuntimeTrack) => input.stemMode === 'channel-output'
    ? track.channelRole === 'group' || track.channelRole === 'return'
    : isRenderableExportTrack(track)

  if (input.stemSelection === 'all-tracks') return input.tracks.filter(matchesMode)
  const selectedIds = new Set(input.selectedTrackIds)

  return input.tracks.filter((track) => selectedIds.has(track.id) && matchesMode(track))
}


export async function runTimelineExport(input: TimelineExportRequest): Promise<ExportOutcome> {
  const outputs: ExportOutput[] = []
  const localMetadataRows: LocalExportMetadataInput[] = []
  let outputTarget: Awaited<ReturnType<ExportOutputTargetFactory["createMixdownTarget"]>> | undefined
  let localProjectId: string | undefined
  let nativeSpool: NativeOfflinePcmSpoolSession | undefined
  let nativeSpoolRemoved = false
  let nativeStretchRepository: PreparedStretchArtifactRepository | undefined
  let nativeStretchCache: ReturnType<typeof createAudioStretchCache> | undefined
  let nativeTimelinePageManager: NativeTimelinePageManager | undefined
  let nativeStretchLeaseDispose: (() => Promise<void>) | undefined
  let portableRepository: PreparedStretchArtifactRepository | undefined
  let portableWorkerCleanup: (() => Promise<void>) | undefined
  const nativeInstrumentSources = new Map<string, AudioBuffer>()

  const removeNativeSpool = async () => {
    if (!nativeSpool || nativeSpoolRemoved) return
    await nativeSpool.remove()
    nativeSpoolRemoved = true
  }

  const disposeNativeStretchResources = async () => {
    await nativeTimelinePageManager?.dispose()
    nativeTimelinePageManager = undefined
    await nativeStretchLeaseDispose?.()
    nativeStretchLeaseDispose = undefined
    await nativeStretchCache?.dispose()
    nativeStretchCache = undefined
    await nativeStretchRepository?.dispose?.()
    nativeStretchRepository = undefined
  }

  const disposePortableResources = async () => {
    await portableWorkerCleanup?.().catch(() => undefined)
    portableWorkerCleanup = undefined
    await portableRepository?.dispose?.().catch(() => undefined)
    portableRepository = undefined
  }

  const saveCompletedLocalMetadata = async () => {
    if (!localProjectId) return
    await saveLocalExportMetadataBatch(localProjectId, localMetadataRows)
    localMetadataRows.length = 0
  }

  try {
    if (input.nativeRendererRequired && !input.nativeOfflinePcmRenderer) {
      throw new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)
    }

    input.onProgress?.({ phase: 'snapshot' })
    const formats = requireExportFormats(input.formats)
    const multiFormat = formats.length > 1
    const exportDate = new Date()
    const firstFormat = formats[0]
    const firstFileName = createMixdownFileName(exportDate, firstFormat)
    const preloadTracks = input.getTracks()
    preflightExportResources({
      tracks: preloadTracks,
      range: input.range,
      formats,
      render: input.render,
      encoding: input.encoding,
      stemCount: 1,
      resourceLimits: input.outputTargets.resourceLimits,
    })
    const projectId = input.projectId
    const localProject = projectId ? await getLocalProject(projectId) : undefined
    localProjectId = projectId && (isLocalId('project', projectId) || localProject !== undefined) ? projectId : undefined
    input.onProgress?.({ phase: 'source-range' })
    const sourceBounds = getExportRangeBounds(preloadTracks, input.range)
    input.onProgress?.({ phase: 'preroll' })
    input.onProgress?.({ phase: 'tail' })
    const tailMaximumSec = getExportTailMaximumSec(input.render.tail)

    const renderRange: ExportRange = {
      mode: 'custom',
      startSec: sourceBounds.startSec,
      endSec: sourceBounds.endSec + tailMaximumSec,
    }

    const mixdownModule = import('@daw-browser/audio-engine/export-mixdown')
    const fx = cloneExportFx(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map(cloneAutomationEnvelope)

    const nativeTracks = input.nativeRendererRequired
      ? filterTracksToExportRange(preloadTracks, input.range)
      : preloadTracks

    const nativeStretchTracks = nativeTracks.map((track) => ({
      ...track,
      clips: track.clips.filter(isPortableStretchClip),
    }))

    const mayRenderPortableTimeline = !input.nativeRendererRequired
      && input.renderStateSnapshot.automationEnvelopes.length === 0
      && input.sidechainRoutes.length === 0
      && Boolean(input.resolveAudioSource)

    const preparation = await Promise.allSettled([
      mixdownModule,
      input.nativeRendererRequired
        ? ensureNativeStretchBuffers({
          ...input,
          tracks: nativeStretchTracks,
          range: input.range,
        })
        : Promise.resolve(),
      loadInstrumentExportBuffers(
        fx,
        input.signal,
        undefined,
        localProjectId,
        input.sampledInstrumentRegionScope,
        input.nativeRendererRequired ? nativeInstrumentExportMemory : portableInstrumentExportMemory,
      ),
    ])

    for (const result of preparation) if (result.status === 'rejected') throw result.reason
    const mixdown = preparation[0]

    if (mixdown.status === 'rejected') throw mixdown.reason
    const exportMixdown = mixdown.value
    throwIfExportAborted(input.signal)
    let preparedStretchAssets: readonly NativePreparedStretchAsset[] = []

    if (input.nativeRendererRequired && nativeTracks.some((track) => track.clips.some(isPortableStretchClip))) {
      if (!globalThis.indexedDB || !globalThis.navigator?.locks) {
        throw new Error("Native Stretch export requires IndexedDB and cross-realm Web Locks for bounded artifact storage.")
      }

      nativeStretchRepository = createPreparedStretchArtifactRepository()
      nativeStretchCache = createAudioStretchCache({
        resolveSource: input.resolveAudioSource,
        artifactRepository: nativeStretchRepository,
      })

      const preparation = await prepareNativeStretchArtifacts({
        tracks: nativeTracks,
        projectBpm: input.bpm,
        projectGeneration: input.projectGeneration,
        cache: nativeStretchCache,
        repository: nativeStretchRepository,
        signal: input.signal,
      })

      throwIfExportAborted(input.signal)

      if (!preparation.supported) {
        throw new Error(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(' '))
      }

      preparedStretchAssets = preparation.assets
      nativeStretchLeaseDispose = preparation.dispose
    }

    if (input.getProjectGeneration && input.getProjectGeneration() !== input.projectGeneration) {
      throw new Error('Project changed while preparing export.')
    }

    const nativeRender = input.nativeRendererRequired
      ? compileNativeOfflineRenderPlan({
        tracks: nativeTracks,
        fx,
        automationEnvelopes,
        sidechainRoutes: input.sidechainRoutes,
        bpm: input.bpm,
        timeSignature: input.timeSignature,
        range: input.range,
        sampleRateHz: input.render.sampleRate,
        channelCount: input.render.numberOfChannels,
        tailFrames: Math.ceil(tailMaximumSec * input.render.sampleRate),
        projectId: input.projectId,
        projectGeneration: input.projectGeneration,
        preparedStretchAssets,
        externalAttachments: input.renderStateSnapshot.nativeExternalAttachments,
        capturedVstStates: input.renderStateSnapshot.capturedVstStates,
        onInstrumentRegionSources: (sources) => {
          for (const source of sources) nativeInstrumentSources.set(source.sourceAssetKey, source.buffer)
        },
      })
      : undefined

    const nativePlan = nativeRender?.plan
    let latencyFrames = nativeRender?.latencyFrames ?? 0
    outputTarget = await input.outputTargets.createMixdownTarget({
      projectId,
      localProject: Boolean(localProjectId),
      multiFormat,
      firstFormat,
      firstFileName,
      firstFileTypes: createSaveTypes(firstFormat),
    })
    throwIfExportAborted(input.signal)
    input.onProgress?.({ phase: 'rendering' })
    let portableSpool: NativeOfflinePcmSpoolSession | undefined

    if (!nativePlan && mayRenderPortableTimeline) {
      if (!globalThis.indexedDB || !globalThis.navigator?.locks) {
        throw new Error('Portable export requires IndexedDB and Web Locks for bounded artifact and PCM spool storage.')
      }

      portableRepository = createPreparedStretchArtifactRepository()

      const portableMixdown = await exportMixdown.renderPortableMixdownChunks({
        tracks: preloadTracks,
        bpm: input.bpm,
        range: renderRange,
        sourceEndSec: sourceBounds.endSec,
        sampleRate: input.render.sampleRate,
        numberOfChannels: input.render.numberOfChannels,
        fx,
        automationEnvelopes,
        sidechainRoutes: input.sidechainRoutes,
        resolveAudioSource: input.resolveAudioSource,
        preparedStretchRepository: portableRepository,
        projectGeneration: input.projectGeneration,
        signal: input.signal,
      }, async (index, startFrame, pcm, totalFrames) => {
        if (!portableSpool) {
          const spools = createNativeOfflinePcmSpool()

          const session = await spools.createSession({
            sessionId: `portable-${crypto.randomUUID()}`,
            sampleRate: input.render.sampleRate,
            channelCount: input.render.numberOfChannels,
            totalFrames,
          })

          portableSpool = session
          nativeSpool = portableSpool
          nativeSpoolRemoved = false
        }

        const spool = portableSpool

        if (!spool) throw new Error('Portable export PCM spool was not created.')
        await spool.append({
          startFrame,
          frameCount: pcm.frameCount,
          channelCount: pcm.planes.length,
          planes: pcm.planes,
        })
        void index
      })

      if (!portableMixdown) throw new Error('Portable timeline export is unavailable for this project.')
      portableWorkerCleanup = portableMixdown.cleanup
      latencyFrames = portableMixdown.latencyFrames
    }

    if (nativePlan || portableSpool) {
      const nativeRenderer = input.nativeOfflinePcmRenderer

      if (nativePlan && !nativeRenderer) throw new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)

      const mapped = await prepareNativeMappedSources({
        mappedAssets: nativePlan?.mappedAssets,
        tracks: preloadTracks,
        instrumentSources: nativeInstrumentSources,
        stretchRepository: nativeStretchRepository,
        resolveAudioSource: input.resolveAudioSource,
        signal: input.signal,
      })

      nativeTimelinePageManager = mapped.pageManager
      const { provideMappedPage } = mapped

      const spool = nativePlan
        ? await (nativeRenderer
          ? nativeRenderer(nativePlan, input.signal, (renderedFrames, totalFrames) => {
          input.onProgress?.({ phase: 'rendering', renderedFrames, totalRenderFrames: totalFrames })
            }, provideMappedPage)
          : Promise.reject<NativeOfflinePcmSpoolSession>(new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)))
        : portableSpool

      if (!spool) throw new Error('Portable export did not produce a PCM spool.')

      if (nativePlan) {
        nativeSpool = spool
        nativeSpoolRemoved = false
      }

      const processed = await processNativeOfflinePcmSpool({
        spool,
        latencyFrames,
        sourceDurationSec: sourceBounds.endSec - sourceBounds.startSec,
        render: input.render,
        signal: input.signal,
      })

      input.onProgress?.({ phase: 'analyzing' })

      if (input.render.normalization.mode !== 'none') input.onProgress?.({ phase: 'gain' })

      if (input.render.normalization.mode === 'loudness' && input.render.normalization.limiting === 'true-peak') {
        input.onProgress?.({ phase: 'limiting' })
      }

      input.onProgress?.({ phase: 'verifying', analysis: processed.analysis })
      const ditherSeed = createExportSeed()
      let completedFormats = 0

      for (const format of formats) {
        const fileName = createMixdownFileName(exportDate, format)
        const fileSink = await outputTarget.openFile(fileName)

        try {
          if (format === 'wav') reportFormatProgress(input, 'quantizing', format, completedFormats, formats.length)
          reportFormatProgress(input, 'encoding', format, completedFormats, formats.length)

          const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
            reportFormatProgress(input, 'encoding', format, completedFormats, formats.length, sizeBytes)
          })

          const enc = await exportMixdown.encodeAudioChunks(processed.replay(), {
            format,
            bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
            target: fileSink?.target ?? { mode: 'buffer' },
            signal: input.signal,
            onWrite: reportEncodingProgress,
            wav: input.encoding.wav,
            ditherSeed,
          })

          throwIfExportAborted(input.signal)
          const committed = await fileSink?.commit()
          const savedName = fileSink?.name ?? fileName
          const sizeBytes = committed?.byteLength ?? enc.sizeBytes

          if (fileSink) {
            reportFormatProgress(input, 'saving', format, completedFormats, formats.length)

            if (localProjectId) {
              localMetadataRows.push({
                name: savedName,
                format: enc.format,
                durationSec: enc.durationSec,
                sampleRate: enc.sampleRate,
                sizeBytes,
              })
            }

            outputs.push({ destination: 'local', name: savedName, sizeBytes, analysis: processed.analysis })
          } else {
            if (!enc.blob) throw new Error('Export did not produce a downloadable file.')
            reportFormatProgress(input, 'saving', format, completedFormats, formats.length)

            const saved = await outputTarget.saveBuffer({
              blob: enc.blob,
              fileName,
              types: createSaveTypes(format),
              format: enc.format,
              durationSec: enc.durationSec,
              sampleRate: enc.sampleRate,
              signal: input.signal,
            })

            throwIfExportAborted(input.signal)

            if (localProjectId) {
              if (saved.destination !== 'local') {
                throw new Error('Local export target selected a cloud destination.')
              }

              localMetadataRows.push({
                name: saved.name,
                format: enc.format,
                durationSec: enc.durationSec,
                sampleRate: enc.sampleRate,
                sizeBytes,
              })
              outputs.push({
                destination: 'local',
                name: saved.name,
                sizeBytes,
                analysis: processed.analysis,
              })
            } else {
              if (saved.destination !== 'cloud') {
                throw new Error('Cloud export target selected a local destination.')
              }

              outputs.push({
                destination: 'cloud',
                name: saved.name,
                url: saved.url,
                sizeBytes,
                analysis: processed.analysis,
              })
            }
          }
        } catch (error) {
          await fileSink?.abort(error)
          throw error
        }

        completedFormats += 1
      }

      await saveCompletedLocalMetadata()
      await removeNativeSpool()

      return { type: 'success', outputs }
    } else {
      throw new Error(
        input.nativeRendererRequired
          ? NATIVE_EXPORT_UNAVAILABLE_MESSAGE
          : 'Portable timeline export does not support automation, sidechain routing, or unavailable source paging.',
      )
    }
  } catch (err) {
    try {
      await saveCompletedLocalMetadata()
    } catch {}

    if (isAbortError(err)) return { type: 'canceled', outputs }

    return {
      type: 'error',
      message: err instanceof Error ? err.message : 'Export failed',
      failureOwner: err instanceof NativeOfflineRenderError ? 'native' : undefined,
      outputs,
    }
  } finally {
    try {
      await disposePortableResources()
    } catch (cleanupError) {
      console.error('[export] portable export cleanup failed after export failure', cleanupError)
    }

    try {
      await removeNativeSpool()
    } catch (cleanupError) {
      console.error('[export] native offline PCM cleanup failed after export failure', cleanupError)
    }

    try {
      await outputTarget?.dispose?.()
    } catch {}

    try {
      await disposeNativeStretchResources()
    } catch (cleanupError) {
      console.error('[export] native Stretch cleanup failed after export', cleanupError)
    }

    input.sampledInstrumentRegionScope?.release()
    nativeInstrumentSources.clear()
  }
}

export async function runStemExport(input: StemExportRequest): Promise<ExportOutcome> {
  const outputs: ExportOutput[] = []
  let stemSpool: NativeOfflinePcmSpoolSession | undefined
  let portableRepository: PreparedStretchArtifactRepository | undefined

  try {
    if (input.nativeRendererRequired) {
      return { type: 'error', message: NATIVE_EXPORT_UNAVAILABLE_MESSAGE, outputs }
    }

    input.onProgress?.({ phase: 'snapshot' })
    const formats = requireExportFormats(input.formats)
    const preloadTracks = input.getTracks()
    const preloadStemTracks = collectStemTracks({ ...input, tracks: preloadTracks })

    if (preloadStemTracks.length === 0) throw new Error('Select at least one track to export stems.')
    preflightExportResources({
      tracks: preloadTracks,
      range: input.range,
      formats,
      render: input.render,
      encoding: input.encoding,
      stemCount: preloadStemTracks.length,
      resourceLimits: input.outputTargets.resourceLimits,
    })
    throwIfExportAborted(input.signal)
    const fx = cloneExportFx(input.renderStateSnapshot.fx)
    const automationEnvelopes = input.renderStateSnapshot.automationEnvelopes.map(cloneAutomationEnvelope)
    const exportMixdown = await import('@daw-browser/audio-engine/export-mixdown')
    const sourceBounds = getExportRangeBounds(preloadTracks, input.range)
    const tailMaximumSec = getExportTailMaximumSec(input.render.tail)

    const renderRange: ExportRange = {
      mode: 'custom',
      startSec: sourceBounds.startSec,
      endSec: sourceBounds.endSec + tailMaximumSec,
    }

    const graph = exportMixdown.resolveExportMixerGraph({ tracks: preloadTracks, fx })
    const preloadTrackIds = new Set<string>()

    for (const track of preloadStemTracks) {
      const plan = createStemRenderPlan(
        graph,
        { id: track.id, name: track.name, mode: input.stemMode, targetTrackId: track.id },
        input.sidechainRoutes,
      )

      for (const id of plan.sourceTrackIds) preloadTrackIds.add(id)

      for (const id of plan.detectorOnlyTrackIds) preloadTrackIds.add(id)

      const scope = createSourceAutomationScope(plan.graph, {
        sourceTrackIds: plan.sourceTrackIds,
        includeMasterFx: input.stemMode === 'full-master-contribution',
      })

      for (const id of scope.trackIds ?? []) preloadTrackIds.add(id)
    }

    const localProject = input.projectId ? await getLocalProject(input.projectId) : undefined

    const localProjectId = input.projectId
      && (isLocalId('project', input.projectId) || localProject !== undefined)
      ? input.projectId
      : undefined

    const mayRenderPortableStems = automationEnvelopes.length === 0
      && input.sidechainRoutes.length === 0
      && Boolean(input.resolveAudioSource)

    if (!mayRenderPortableStems) {
      throw new Error('Portable stem export does not support automation, sidechain routing, or unavailable source paging.')
    }

    const outputTarget = await input.outputTargets.createStemTarget()
    throwIfExportAborted(input.signal)

    if (mayRenderPortableStems && (!globalThis.indexedDB || !globalThis.navigator?.locks)) {
      throw new Error('Portable stem export requires IndexedDB and Web Locks for bounded artifact and PCM spool storage.')
    }

    await loadInstrumentExportBuffers(
      fx,
      input.signal,
      preloadTrackIds,
      localProjectId,
      input.sampledInstrumentRegionScope,
    )
    throwIfExportAborted(input.signal)
    const tracks = preloadTracks
    const stemTracks = preloadStemTracks
    let completedStems = 0
    const usedStemFileNames = new Set<string>()

    if (mayRenderPortableStems) portableRepository = createPreparedStretchArtifactRepository()

    for (const track of stemTracks) {
      input.onProgress?.({
        phase: 'rendering',
        currentStemName: track.name,
        completedStems,
        totalStems: stemTracks.length,
      })

      const plan = createStemRenderPlan(
        graph,
        { id: track.id, name: track.name, mode: input.stemMode, targetTrackId: track.id },
        input.sidechainRoutes,
      )

      let processedSpool: Awaited<ReturnType<typeof processNativeOfflinePcmSpool>> | undefined

      if (mayRenderPortableStems) {
        const stemTrackIds = new Set([...plan.sourceTrackIds, ...plan.detectorOnlyTrackIds])

        const portable = await exportMixdown.renderPortableMixdownChunks({
          tracks,
          bpm: input.bpm,
          range: renderRange,
          sourceEndSec: sourceBounds.endSec,
          sampleRate: input.render.sampleRate,
          numberOfChannels: input.render.numberOfChannels,
          fx,
          automationEnvelopes,
          sidechainRoutes: input.sidechainRoutes,
          resolveAudioSource: input.resolveAudioSource,
          preparedStretchRepository: portableRepository,
          projectGeneration: input.projectGeneration,
          mixerGraph: plan.graph,
          trackIds: stemTrackIds,
          signal: input.signal,
        }, async (index, startFrame, pcm, totalFrames) => {
          if (!stemSpool) {
            const spools = createNativeOfflinePcmSpool()
            stemSpool = await spools.createSession({
              sessionId: `portable-stem-${crypto.randomUUID()}`,
              sampleRate: input.render.sampleRate,
              channelCount: pcm.planes.length,
              totalFrames,
            })
          }

          await stemSpool.append({
            startFrame,
            frameCount: pcm.frameCount,
            channelCount: pcm.planes.length,
            planes: pcm.planes,
          })
          void index
        })

        if (!portable) throw new Error('Portable stem export is unavailable for this project.')
        await portable.cleanup()

        if (!stemSpool) throw new Error('Portable stem export did not produce a PCM spool.')
        const spool = stemSpool
        processedSpool = await processNativeOfflinePcmSpool({
          spool,
          latencyFrames: portable.latencyFrames,
          sourceDurationSec: sourceBounds.endSec - sourceBounds.startSec,
          render: input.render,
          signal: input.signal,
        })
      }

      const renderedStemMetadata = plan.metadata
      throwIfExportAborted(input.signal)
      const processed = processedSpool

      if (!processed) throw new Error('Portable stem export did not produce processed audio.')
      const analysis = processed.analysis

      if (!analysis) throw new Error('Stem export analysis is unavailable.')
      let completedFormats = 0

      for (const format of formats) {
        const metadata = getExportAudioFormatMetadata(format)
        const fileName = createUniqueStemFileName(track.name, metadata.fileExtension, usedStemFileNames)
        const fileSink = await outputTarget.openFile(fileName)
        let committed: ExportFileCommit = {}
        let encodedSizeBytes = 0

        try {
          reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length)

          const reportEncodingProgress = createEncodingProgressReporter((sizeBytes) => {
            reportStemFormatProgress(input, 'encoding', format, track, completedStems, stemTracks.length, completedFormats, formats.length, sizeBytes)
          })

          const encoded = await exportMixdown.encodeAudioChunks(processed.replay(), {
            format,
            bitrate: isLossyExportAudioFormat(format) ? input.encoding.bitrateByFormat[format] : undefined,
            target: fileSink.target,
            signal: input.signal,
            onWrite: reportEncodingProgress,
            wav: input.encoding.wav,
            ditherSeed: createExportSeed(),
          })

          encodedSizeBytes = encoded.sizeBytes
          throwIfExportAborted(input.signal)
          committed = await fileSink.commit()
        } catch (error) {
          await fileSink.abort(error)
          throw error
        }

        outputs.push({ destination: 'local', name: `stems/${fileName}`, sizeBytes: committed.byteLength ?? encodedSizeBytes, analysis, stem: renderedStemMetadata })
        completedFormats += 1
        throwIfExportAborted(input.signal)
      }

      await stemSpool?.remove()
      stemSpool = undefined
      completedStems += 1
      throwIfExportAborted(input.signal)
    }

    input.onProgress?.({ phase: 'saving', completedStems, totalStems: stemTracks.length })

    return { type: 'success', outputs }
  } catch (err) {
    if (isAbortError(err)) return { type: 'canceled', outputs }

    return {
      type: 'error',
      message: err instanceof Error ? err.message : 'Stem export failed',
      outputs,
    }
  } finally {
    try {
      await stemSpool?.remove()
    } catch {}

    try {
      await portableRepository?.dispose?.()
    } catch {}

    input.sampledInstrumentRegionScope?.release()
  }
}
