type TrackMixValues = Partial<{
  volume: number
  muted: boolean
  soloed: boolean
}>

type ResolveTrackMixViewInput = {
  canWriteSharedMix: boolean
  syncMix: boolean
  current?: TrackMixValues | null
  local?: TrackMixValues | null
  server?: TrackMixValues | null
  pendingShared?: TrackMixValues | null
}

type ResolvedTrackMixView = {
  volume: number | undefined
  muted: boolean
  soloed: boolean
}

const firstNumber = (values: Array<number | undefined>) => {
  for (const value of values) {
    if (typeof value === 'number') return value
  }
  return undefined
}

const firstBoolean = (values: Array<boolean | undefined>, fallback = false) => {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return fallback
}

const resolveTrackMixFlag = (input: {
  canWriteSharedMix: boolean
  syncMix: boolean
  currentValue: boolean | undefined
  localValue: boolean | undefined
  serverValue: boolean | undefined
  pendingSharedValue: boolean | undefined
}) => {
  const {
    canWriteSharedMix,
    syncMix,
    currentValue,
    localValue,
    serverValue,
    pendingSharedValue,
  } = input
  if (canWriteSharedMix) {
    return firstBoolean([pendingSharedValue, serverValue, currentValue])
  }
  if (syncMix) {
    return firstBoolean([serverValue, currentValue, localValue])
  }
  return firstBoolean([localValue, currentValue, serverValue])
}

export function resolveTrackMixView(
  input: ResolveTrackMixViewInput,
): ResolvedTrackMixView {
  const current = input.current ?? {}
  const local = input.local ?? {}
  const server = input.server ?? {}
  const pendingShared = input.pendingShared ?? {}

  const volume = input.canWriteSharedMix
    ? firstNumber([pendingShared.volume, server.volume, current.volume])
    : input.syncMix
      ? firstNumber([server.volume, current.volume])
      : firstNumber([local.volume, server.volume, current.volume])

  return {
    volume,
    muted: resolveTrackMixFlag({
      canWriteSharedMix: input.canWriteSharedMix,
      syncMix: input.syncMix,
      currentValue: current.muted,
      localValue: local.muted,
      serverValue: server.muted,
      pendingSharedValue: pendingShared.muted,
    }),
    soloed: resolveTrackMixFlag({
      canWriteSharedMix: input.canWriteSharedMix,
      syncMix: input.syncMix,
      currentValue: current.soloed,
      localValue: local.soloed,
      serverValue: server.soloed,
      pendingSharedValue: pendingShared.soloed,
    }),
  }
}
