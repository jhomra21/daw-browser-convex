import {
  desktopControlOperationsV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"

export const desktopOperations = (nativeMediaAvailable: boolean): DesktopOperationV1[] => {
  const base: DesktopOperationV1[] = [
    "host.status",
    "transport.status", "transport.play", "transport.pause", "transport.stop", "transport.seek",
    "diagnostics.snapshot",
    ...desktopControlOperationsV1,
  ]
  return nativeMediaAvailable
    ? ["host.vst.instances", "host.vst.parameters", "host.import.audio", "host.export.run", "host.export.status", "host.export.cancel", ...base]
    : base
}
