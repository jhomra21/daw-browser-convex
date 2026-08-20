import {
  desktopControlOperationsV1,
  desktopHostOperationIds,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"

export const desktopOperations = (nativeMediaAvailable: boolean): DesktopOperationV1[] => {
  const base = desktopHostOperationIds.filter((operation) => (
    nativeMediaAvailable
    || !operation.startsWith("host.vst.")
      && operation !== "host.import.audio"
      && operation !== "host.export.run"
      && operation !== "host.export.status"
      && operation !== "host.export.cancel"
  ))
  return [...base, ...desktopControlOperationsV1]
}
