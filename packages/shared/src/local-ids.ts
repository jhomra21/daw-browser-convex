type LocalIdKind = 'project' | 'track' | 'clip' | 'asset'

const createLocalId = (kind: LocalIdKind) => `${kind}:${crypto.randomUUID()}`
export const createLocalProjectId = () => createLocalId('project')
export const createLocalTrackId = () => createLocalId('track')
export const createLocalClipId = () => createLocalId('clip')
export const createLocalAssetId = () => createLocalId('asset')

export const isLocalId = (kind: LocalIdKind, value: string) => value.startsWith(`${kind}:`)
