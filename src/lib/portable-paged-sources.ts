import type { PortableWasmPlaybackSession } from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import type { AudioAssetRef } from "@daw-browser/audio-core-contract"
import type { PreparedPortableSession } from "@daw-browser/audio-engine/portable-session-compiler"
import { portableWasmPagedPageFrames, portableWasmPagedSlotCount, type PortableWasmPreparedSourceEvent } from "@daw-browser/audio-engine/portable-wasm-protocol"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { PreparedStretchArtifactRepository } from "@daw-browser/audio-engine/prepared-stretch-store"
import type { AudioPcmSourceDescriptor, DecodedAudioPage } from "@daw-browser/shared"
import { isPagedStretchAsset, planarPcm, preparedSession } from "~/lib/portable-playback-assets"
import type { PortablePreparedStretch, PortableOrdinaryDescriptor } from "~/lib/portable-playback-assets"

export type PortableSession = Pick<
  PortableWasmPlaybackSession,
  | "connectInput" | "dispose" | "installSchedule" | "markActive" | "onFault" | "onRecordingStatus" | "postRecordingControl" | "prepareGraph" | "publishGraph" | "registerAsset" | "scheduleSources" | "setTransport"
> & {
  releaseAsset?: PortableWasmPlaybackSession["releaseAsset"]
  pagedCapabilities?: PortableWasmPlaybackSession["pagedCapabilities"]
  registerPagedAsset?: PortableWasmPlaybackSession["registerPagedAsset"]
  writeAssetPage?: PortableWasmPlaybackSession["writeAssetPage"]
  prepareAssetRange?: PortableWasmPlaybackSession["prepareAssetRange"]
  schedulePreparedSources?: PortableWasmPlaybackSession["schedulePreparedSources"]
  replaceSources?: PortableWasmPlaybackSession["replaceSources"]
  resetSources?: PortableWasmPlaybackSession["resetSources"]
  releaseAssetPreparation?: PortableWasmPlaybackSession["releaseAssetPreparation"]
  trimAssetPages?: PortableWasmPlaybackSession["trimAssetPages"]
  queueProcessorEvents?: PortableWasmPlaybackSession["queueProcessorEvents"]
  queueInstrumentEvents?: PortableWasmPlaybackSession["queueInstrumentEvents"]
  reenableProcessorAutomation?: PortableWasmPlaybackSession["reenableProcessorAutomation"]
  onTransportPosition?: PortableWasmPlaybackSession["onTransportPosition"]
  onGraphContinuity?: PortableWasmPlaybackSession["onGraphContinuity"]
}

export type PortablePagedPreparation = {
  id: number
  assetId: string
  // The range it prepared: a source with the same offset and coverage can play from it.
  sourceOffsetFrame: number
  coverageEnd: number
  pageKeys: readonly string[]
  stopFrame: number
  released: boolean
}

export type PortablePreparedSource = PortableWasmPreparedSourceEvent & {
  preparation: PortablePagedPreparation
}

const pagedSourceCoverage = (
  asset: {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  },
  source: Extract<PreparedPortableSession, { supported: true }>["sources"][number],
) => {
  const sourceOffset = source.sourceOffsetFrame + (source.sourceOffsetFraction ?? 0)
  const lastPosition = sourceOffset + source.sourceFrameCount - 1
  const coverageEnd = Math.min(asset.asset.frameCount, Math.floor(lastPosition) + 2)

  if (
    !Number.isFinite(sourceOffset)
    || !Number.isSafeInteger(source.sourceOffsetFrame)
    || source.sourceOffsetFrame < 0
    || !Number.isSafeInteger(source.sourceFrameCount)
    || source.sourceFrameCount < 1
    || source.sourceOffsetFrame >= asset.asset.frameCount
    || source.sourceFrameCount > asset.asset.frameCount - source.sourceOffsetFrame
    || coverageEnd <= source.sourceOffsetFrame
  ) return undefined
  const firstPage = Math.floor(source.sourceOffsetFrame / asset.pageFrames)
  const lastPage = Math.floor((coverageEnd - 1) / asset.pageFrames)

  const pageKeys = Array.from(
    { length: lastPage - firstPage + 1 },
    (_, index) => `${asset.asset.assetId}:${firstPage + index}`,
  )

  return { firstPage, lastPage, coverageEnd, pageKeys }
}

export const requiredPagedPagePlan = (
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][],
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
) => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...preparedStretchAssets.flatMap((asset) => isPagedStretchAsset(asset) ? [[asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const] : []),
  ])

  const keys = new Set<string>()
  let preparationCount = 0

  for (const source of sources) {
    const asset = pagedAssets.get(source.assetId)

    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)

    if (!coverage) return undefined
    preparationCount += 1

    for (const key of coverage.pageKeys) keys.add(key)
  }

  return { pageKeys: keys, preparationCount }
}

export const pagedCapacityError = (input: {
  pageCount: number
  pageCapacity: number
  preparationCount: number
  preparationCapacity: number
  baselinePreparationCount?: number
}) => {
  if (input.pageCount > input.pageCapacity) {
    return new Error(
      `Portable paged playback requires ${input.pageCount} resident pages, `
        + `but only ${input.pageCapacity} are available.`,
    )
  }

  const totalPreparations = input.preparationCount + (input.baselinePreparationCount ?? 0)

  if (totalPreparations > input.preparationCapacity) {
    if (input.baselinePreparationCount === undefined) {
      return new Error(
        `Portable paged playback requires ${input.preparationCount} prepared ranges, `
          + `but only ${input.preparationCapacity} are available.`,
      )
    }

    return new Error(
      `Portable paged playback refresh requires ${totalPreparations} prepared ranges `
        + `(${input.baselinePreparationCount ?? 0} active baseline + ${input.preparationCount} continuation), `
        + `but only ${input.preparationCapacity} are available.`,
    )
  }

  return undefined
}

export const fitPortableStartupHorizon = (input: {
  snapshot: LivePlaybackSnapshot
  sampleRateHz: number
  epoch: number
  projectGeneration: number
  requestedHorizonSec: number
  sourceFirstSequence: number
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  pageSlotCapacity: number
  preparationCapacity: number
  signal?: AbortSignal
}) => {
  const pageFrames = portableWasmPagedPageFrames
  const requestedFrames = Math.max(pageFrames, Math.round(input.requestedHorizonSec * input.sampleRateHz))

  for (
    let horizonFrames = requestedFrames;
    horizonFrames >= pageFrames;
    horizonFrames -= pageFrames
  ) {
    input.signal?.throwIfAborted()
    const horizonSec = horizonFrames / input.sampleRateHz

    const prepared = preparedSession(
      input.snapshot,
      input.sampleRateHz,
      input.epoch,
      input.projectGeneration,
      horizonSec,
      input.sourceFirstSequence,
      input.preparedStretchAssets,
      undefined,
      input.ordinaryDescriptors,
    )

    if (!prepared.supported) continue

    const plan = requiredPagedPagePlan(
      prepared.sources,
      input.preparedStretchAssets,
      input.ordinaryDescriptors,
    )

    if (!plan) throw new Error("Portable paged source range is outside its prepared asset.")

    if (
      plan.pageKeys.size <= input.pageSlotCapacity
      && plan.preparationCount <= input.preparationCapacity
    ) return prepared
  }

  const minimumPrepared = preparedSession(
    input.snapshot,
    input.sampleRateHz,
    input.epoch,
    input.projectGeneration,
    pageFrames / input.sampleRateHz,
    input.sourceFirstSequence,
    input.preparedStretchAssets,
    undefined,
    input.ordinaryDescriptors,
  )

  if (!minimumPrepared.supported) throw new Error("Portable paged playback minimum horizon is unsupported.")

  const minimumPlan = requiredPagedPagePlan(
    minimumPrepared.sources,
    input.preparedStretchAssets,
    input.ordinaryDescriptors,
  )

  if (!minimumPlan) throw new Error("Portable paged source range is outside its prepared asset.")

  const capacityError = pagedCapacityError({
    pageCount: minimumPlan.pageKeys.size,
    pageCapacity: input.pageSlotCapacity,
    preparationCount: minimumPlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
  })

  if (capacityError) throw capacityError
  throw new Error(
    `Portable paged playback requires ${minimumPlan.preparationCount} prepared ranges, `
      + `but only ${input.preparationCapacity} are available.`,
  )
}

const readPortableWasmPages = async function* (input: {
  descriptor: AudioPcmSourceDescriptor
  startFrame: number
  endFrame: number
  signal?: AbortSignal
}): AsyncGenerator<DecodedAudioPage> {
  const pageFrames = portableWasmPagedPageFrames
  const { descriptor, startFrame, endFrame, signal } = input
  let expectedStartFrame = startFrame
  let accumulatedFrames = 0
  let accumulatedPlanes: Float32Array[] | undefined

  for await (const page of descriptor.readPages({ startFrame, endFrame, signal })) {
    signal?.throwIfAborted()

    if (
      !Number.isSafeInteger(page.startFrame)
      || !Number.isSafeInteger(page.frameCount)
      || page.startFrame !== expectedStartFrame
      || page.frameCount <= 0
      || page.startFrame + page.frameCount > endFrame
      || page.sampleRate !== descriptor.sampleRate
      || page.channelCount !== descriptor.channelCount
      || page.planes.length !== descriptor.channelCount
      || page.planes.some((plane) => plane.length !== page.frameCount)
    ) {
      throw new Error("Portable ordinary source page metadata or coverage is invalid.")
    }

    const planes = accumulatedPlanes ?? Array.from(
      { length: descriptor.channelCount },
      () => new Float32Array(pageFrames),
    )

    accumulatedPlanes = planes
    let pageOffset = 0

    while (pageOffset < page.frameCount) {
      signal?.throwIfAborted()
      const copyFrames = Math.min(page.frameCount - pageOffset, pageFrames - accumulatedFrames)

      for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
        const sourcePlane = page.planes[channel]
        const destinationPlane = planes[channel]

        if (!sourcePlane || !destinationPlane) {
          throw new Error("Portable ordinary source page channel metadata is invalid.")
        }

        destinationPlane.set(
          sourcePlane.subarray(pageOffset, pageOffset + copyFrames),
          accumulatedFrames,
        )
      }

      pageOffset += copyFrames
      accumulatedFrames += copyFrames
      expectedStartFrame += copyFrames

      if (accumulatedFrames === pageFrames) {
        yield {
          startFrame: expectedStartFrame - pageFrames,
          frameCount: pageFrames,
          sampleRate: descriptor.sampleRate,
          channelCount: descriptor.channelCount,
          planes,
        }
        accumulatedPlanes = undefined
        accumulatedFrames = 0
      }
    }
  }

  signal?.throwIfAborted()

  if (expectedStartFrame !== endFrame) {
    throw new Error("Portable ordinary source pages do not cover the requested range exactly.")
  }

  if (accumulatedFrames > 0) {
    if (!accumulatedPlanes) throw new Error("Portable ordinary source page accumulator is missing.")
    yield {
      startFrame: endFrame - accumulatedFrames,
      frameCount: accumulatedFrames,
      sampleRate: descriptor.sampleRate,
      channelCount: descriptor.channelCount,
      planes: accumulatedPlanes.map((plane) => plane.slice(0, accumulatedFrames)),
    }
  }
}

// Registers an asset of a prepared graph with the worklet, from pages when a descriptor or a Stretch artifact serves it
// and from its decoded buffer otherwise.
export const registerGraphAsset = async (
  session: PortableSession,
  asset: AudioAssetRef,
  snapshot: LivePlaybackSnapshot,
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
  generation: number,
) => {
  const source = snapshot.assets.find((candidate) => candidate.assetId === asset.assetId)
  const preparedSource = preparedStretchAssets.find((candidate) => candidate.asset.assetId === asset.assetId)

  if ((preparedSource && isPagedStretchAsset(preparedSource)) || ordinaryDescriptors.has(asset.assetId)) {
    if (preparedSource && isPagedStretchAsset(preparedSource) && preparedSource.manifest.pageFrames !== portableWasmPagedPageFrames) {
      throw new Error(`Portable Stretch artifact "${preparedSource.artifactId}" has an incompatible page size.`)
    }

    if (!session.registerPagedAsset) throw new Error("Portable playback backend does not expose paged asset support.")
    const registration = await session.registerPagedAsset(asset, generation)

    if (registration.status !== "registered") {
      throw new Error(`Portable paged audio asset "${asset.assetId}" was rejected (${registration.status}).`)
    }

    return
  }

  const pcm = preparedSource?.pcm ?? (source?.buffer ? planarPcm(source.buffer) : undefined)

  if (!pcm) throw new Error(`Portable playback asset "${asset.assetId}" is not hydrated.`)
  const result = await session.registerAsset(asset, pcm, generation)

  if (result.status !== "registered") throw new Error(`Portable audio asset "${asset.assetId}" was rejected.`)
}

const preparedRangeKey = (assetId: string, sourceOffsetFrame: number, coverageEnd: number) =>
  `${assetId}:${sourceOffsetFrame}:${coverageEnd}`

export const releasePreparations = async (session: PortableSession, preparations: readonly PortablePagedPreparation[], generation: number) => {
  await Promise.all(preparations.map(async (preparation) => {
    if (preparation.released) return
    const result = await Promise.resolve(session.releaseAssetPreparation?.(preparation.id, generation)).catch(() => undefined)

    if (result === "released") preparation.released = true
  }))
}

export const preparePagedSources = async (input: {
  session: PortableSession
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  repository: PreparedStretchArtifactRepository
  generation: number
  preparationCapacity: number
  baselinePreparationCount?: number
  pinnedPageKeys?: ReadonlySet<string>
  // Preparations of an earlier attempt: a source whose range one of them holds plays from it, and the caller releases the
  // ones left over. The pages of those ranges are resident already.
  reusable?: readonly PortablePagedPreparation[]
  signal?: AbortSignal
}): Promise<{
  events: readonly PortableWasmPreparedSourceEvent[]
  preparations: readonly PortablePagedPreparation[]
}> => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...input.ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...input.preparedStretchAssets.filter(isPagedStretchAsset).map((asset) => [asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const),
  ])

  if (pagedAssets.size === 0) return { events: [], preparations: [] }

  if (!input.session.prepareAssetRange || !input.session.writeAssetPage || !input.session.releaseAssetPreparation) {
    throw new Error("Portable playback backend does not expose paged asset support.")
  }

  const requiredPages = new Map<string, Set<number>>()
  const pagePlan = requiredPagedPagePlan(input.sources, input.preparedStretchAssets, input.ordinaryDescriptors)

  if (!pagePlan) throw new Error("Portable Stretch source range is outside its prepared asset.")
  const pageKeys = pagePlan.pageKeys
  const pinnedPageKeys = input.pinnedPageKeys ?? new Set<string>()
  const unionPageCount = new Set([...pinnedPageKeys, ...pageKeys]).size

  const capacityError = pagedCapacityError({
    pageCount: unionPageCount,
    pageCapacity: input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
    preparationCount: pagePlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
    baselinePreparationCount: input.baselinePreparationCount,
  })

  if (capacityError) throw capacityError
  const spare = new Map<string, PortablePagedPreparation[]>()

  for (const preparation of input.reusable ?? []) {
    const key = preparedRangeKey(preparation.assetId, preparation.sourceOffsetFrame, preparation.coverageEnd)
    spare.set(key, [...spare.get(key) ?? [], preparation])
  }

  const reused = new Map<typeof input.sources[number], PortablePagedPreparation>()

  for (const source of input.sources) {
    const asset = pagedAssets.get(source.assetId)

    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)

    if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)
    const held = spare.get(preparedRangeKey(source.assetId, source.sourceOffsetFrame, coverage.coverageEnd))?.pop()

    if (held) {
      reused.set(source, held)
      continue
    }

    const pages = requiredPages.get(source.assetId) ?? new Set<number>()

    for (let page = coverage.firstPage; page <= coverage.lastPage; page += 1) pages.add(page)
    requiredPages.set(source.assetId, pages)
  }

  const availableSlots = input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount

  if (unionPageCount > availableSlots) {
    throw new Error(`Portable paged playback requires ${unionPageCount} resident pages, but only ${availableSlots} are available.`)
  }

  const preparations: PortablePagedPreparation[] = []
  const created: PortablePagedPreparation[] = []

  try {
    input.signal?.throwIfAborted()

    for (const [assetId, pages] of requiredPages) {
      const asset = pagedAssets.get(assetId)

      if (!asset) continue

      for (const pageIndex of pages) {
        input.signal?.throwIfAborted()
        const pageStart = pageIndex * asset.pageFrames
        const pageEnd = Math.min(asset.asset.frameCount, pageStart + asset.pageFrames)

        if (pageEnd <= pageStart) throw new Error(`Portable Stretch page ${pageIndex} is outside its asset.`)

        const range = await input.session.prepareAssetRange(
          assetId,
          input.generation,
          pageStart,
          pageEnd - pageStart,
          0,
        )

        if (range.status === "prepared") {
          const release = await input.session.releaseAssetPreparation(range.preparationId, input.generation)

          if (release !== "released") throw new Error(`Portable Stretch page preparation could not be released (${release}).`)
          continue
        }

        if (range.status !== "missing-page" || range.firstMissingPage === undefined) {
          throw new Error(`Portable Stretch page range for "${assetId}" was rejected (${range.status}).`)
        }

        const firstFrame = range.firstMissingPage * asset.pageFrames
        const endFrame = Math.min(asset.asset.frameCount, firstFrame + asset.pageFrames)

        const pages = asset.descriptor
          ? readPortableWasmPages({
            descriptor: asset.descriptor,
            startFrame: firstFrame,
            endFrame,
            signal: input.signal,
          })
          : asset.artifactId
            ? input.repository.read(asset.artifactId, firstFrame, endFrame)
            : undefined

        if (!pages) throw new Error(`Portable asset "${assetId}" has no page source.`)

        for await (const page of pages) {
          input.signal?.throwIfAborted()
          const pageIndex = page.startFrame / asset.pageFrames

          if (
            !Number.isSafeInteger(pageIndex)
            || pageIndex < 0
            || page.startFrame !== pageIndex * asset.pageFrames
            || page.frameCount <= 0
            || page.frameCount > asset.pageFrames
            || page.startFrame + page.frameCount > asset.asset.frameCount
            || page.sampleRate !== asset.asset.sampleRateHz
            || page.channelCount !== asset.asset.channelCount
            || page.planes.length !== asset.asset.channelCount
            || page.planes.some((plane) => plane.length !== page.frameCount)
          ) throw new Error(`Portable asset "${assetId}" page metadata or coverage is invalid.`)
          const result = await input.session.writeAssetPage(assetId, input.generation, pageIndex, page.frameCount, page.planes)
          input.signal?.throwIfAborted()

          if (result.status !== "written") throw new Error(`Portable page ${pageIndex} was rejected (${result.status}).`)
        }
      }
    }

    const events: PortableWasmPreparedSourceEvent[] = []

    for (const source of input.sources) {
      input.signal?.throwIfAborted()
      const asset = pagedAssets.get(source.assetId)

      if (!asset) continue
      const held = reused.get(source)

      if (held) {
        events.push({ ...source, preparationId: held.id })
        preparations.push({ ...held, stopFrame: source.stopFrame })
        continue
      }

      const coverage = pagedSourceCoverage(asset, source)

      if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)

      const range = await input.session.prepareAssetRange(
        source.assetId,
        input.generation,
        source.sourceOffsetFrame,
        coverage.coverageEnd - source.sourceOffsetFrame,
        0,
      )

      input.signal?.throwIfAborted()

      if (range.status !== "prepared") {
        throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" was rejected (${range.status}).`)
      }

      events.push({
        ...source,
        preparationId: range.preparationId,
      })

      const preparation = {
        id: range.preparationId,
        assetId: source.assetId,
        sourceOffsetFrame: source.sourceOffsetFrame,
        coverageEnd: coverage.coverageEnd,
        pageKeys: coverage.pageKeys,
        stopFrame: source.stopFrame,
        released: false,
      }

      preparations.push(preparation)
      created.push(preparation)
    }

    return { events, preparations }
  } catch (error) {
    await Promise.all(created.map((preparation) => input.session.releaseAssetPreparation?.(preparation.id, input.generation)))
    throw error
  }
}

export const withPreparations = (
  events: readonly PortableWasmPreparedSourceEvent[],
  preparations: readonly PortablePagedPreparation[],
): PortablePreparedSource[] => events.map((event) => ({
  ...event,
  preparation: preparations.find((preparation) => preparation.id === event.preparationId)
    ?? (() => { throw new Error(`Portable preparation ${event.preparationId} is missing.`) })(),
}))

// The sources the worklet plays from a registered asset; the rest play from pages.
export const ordinarySourcesOf = (
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][],
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
) => sources.filter((source) => (
  !preparedStretchAssets.some((candidate) => isPagedStretchAsset(candidate) && candidate.asset.assetId === source.assetId)
  && !ordinaryDescriptors.has(source.assetId)
))

// Shrinks a window a page at a time until its paged sources fit the session's page and preparation capacity. `refused`
// is a window that does not compile; `no-fit` is one that fits at no size.
export const fitPagedWindow = async (input: {
  horizonSec: number
  pageSec: number
  compile: (horizonSec: number) => Extract<PreparedPortableSession, { supported: true }> | undefined
  // A refresh keeps the sources it holds and prepares the rest.
  isNew?: (source: Extract<PreparedPortableSession, { supported: true }>["sources"][number]) => boolean
  prepare: (sources: Extract<PreparedPortableSession, { supported: true }>["sources"]) => ReturnType<typeof preparePagedSources>
}): Promise<{
  candidate: Extract<PreparedPortableSession, { supported: true }>
  sources: Extract<PreparedPortableSession, { supported: true }>["sources"]
  paged: Awaited<ReturnType<typeof preparePagedSources>>
} | "refused" | "no-fit"> => {
  const { isNew } = input

  for (let horizonSec = input.horizonSec; horizonSec >= input.pageSec; horizonSec -= input.pageSec) {
    const candidate = input.compile(horizonSec)

    if (!candidate) return "refused"
    const sources = isNew ? candidate.sources.filter(isNew) : candidate.sources

    try {
      return { candidate, sources, paged: await input.prepare(sources) }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("requires ")) throw error
    }
  }

  return "no-fit"
}

const scheduleSourcesInGlobalOrder = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  const ordinaryBySequence = new Map(input.ordinary.map((source) => [source.sequence, source]))
  const preparedBySequence = new Map(input.prepared.map((source) => [source.sequence, source]))
  const sequences = [...new Set([...ordinaryBySequence.keys(), ...preparedBySequence.keys()])].sort((left, right) => left - right)

  if (sequences.length === 0) {
    await input.session.scheduleSources(input.revision, input.epoch, [])

    return
  }

  let index = 0

  while (index < sequences.length) {
    const firstSequence = sequences[index]

    if (firstSequence === undefined) break
    const isPrepared = preparedBySequence.has(firstSequence)

    if (isPrepared) {
      if (!input.session.schedulePreparedSources) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }

      const group: PortableWasmPreparedSourceEvent[] = []

      while (index < sequences.length) {
        const sequence = sequences[index]

        if (sequence === undefined || !preparedBySequence.has(sequence)) break
        const event = preparedBySequence.get(sequence)

        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }

      await input.session.schedulePreparedSources(
        input.revision,
        input.epoch,
        group,
      )
    } else {
      const group: Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []

      while (index < sequences.length) {
        const sequence = sequences[index]

        if (sequence === undefined || preparedBySequence.has(sequence)) break
        const event = ordinaryBySequence.get(sequence)

        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }

      await input.session.scheduleSources(
        input.revision,
        input.epoch,
        group,
      )
    }
  }
}

export const replaceSourcesAtomically = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  if (input.session.replaceSources) {
    await input.session.replaceSources(input.revision, input.epoch, input.ordinary, input.prepared)

    return
  }

  await scheduleSourcesInGlobalOrder(input)
}
