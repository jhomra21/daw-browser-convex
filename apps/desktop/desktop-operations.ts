import type { DesktopOperationV1 } from "@daw-browser/desktop-protocol"

export const desktopOperations = (nativeMediaAvailable: boolean): DesktopOperationV1[] => {
  const base: DesktopOperationV1[] = [
    "host.status",
    "transport.status", "transport.play", "transport.pause", "transport.stop", "transport.seek",
    "diagnostics.snapshot",
    "control.capabilities", "control.snapshot", "control.preview", "control.commit",
    "control.requestApproval", "control.history", "control.recoveries",
  ]
  return nativeMediaAvailable
    ? ["host.import.audio", "host.export.run", "host.export.status", "host.export.cancel", ...base]
    : base
}
