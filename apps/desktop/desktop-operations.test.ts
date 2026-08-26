import { expect, test } from "bun:test"
import { desktopOperations } from "./desktop-operations"

test("advertises static local control operations independently of native media", () => {
  expect(desktopOperations(false)).toHaveLength(14)
  expect(desktopOperations(true)).toHaveLength(20)
  expect(desktopOperations(false)).toEqual([
    "host.status",
    "transport.status", "transport.play", "transport.pause", "transport.stop", "transport.seek",
    "diagnostics.snapshot",
    "control.capabilities", "control.snapshot", "control.preview", "control.commit",
    "control.requestApproval", "control.history", "control.recoveries",
  ])
})

test("keeps host runtime operations in the host catalog", async () => {
  const protocol = await import("@daw-browser/desktop-protocol")
  expect(protocol.desktopHostOperationIds).toContain("host.status")
  expect(protocol.desktopHostOperationIds).toContain("transport.seek")
  expect(protocol.desktopHostOperationIds).toContain("diagnostics.snapshot")
  expect(protocol.desktopHostOperationIds).not.toContain("control.commit")
  expect(protocol.getDesktopHostOperationDescriptor("host.export.run").effect).toBe("write")
})
