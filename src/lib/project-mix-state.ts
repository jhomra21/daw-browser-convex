import { DEFAULT_MASTER_VOLUME, normalizeMasterVolume } from '@daw-browser/shared'

export type ProjectMixState = {
  masterVolume: number
}

export const normalizeProjectMixState = (value: ProjectMixState): ProjectMixState => ({
  masterVolume: normalizeMasterVolume(value.masterVolume),
})

export const defaultProjectMixState = (): ProjectMixState => ({
  masterVolume: DEFAULT_MASTER_VOLUME,
})
