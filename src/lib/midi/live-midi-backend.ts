export type NativeLiveMidiAvailability = {
  isActive: () => boolean
  isAvailable: () => boolean
}

export const shouldUseNativeLiveMidi = (
  nativeLiveMidi: NativeLiveMidiAvailability | undefined,
) => Boolean(nativeLiveMidi && (
  nativeLiveMidi.isActive() || nativeLiveMidi.isAvailable()
))
