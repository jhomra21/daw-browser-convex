import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("desktop export output stays on the scoped capability bridge", async () => {
  const [main, preload, bridge, context, outputTarget] = await Promise.all([
    readFile(new URL("./main.ts", import.meta.url), "utf8"),
    readFile(new URL("./preload.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/types/desktop-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/context/export.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/lib/desktop/capability-export-output-targets.ts", import.meta.url), "utf8"),
  ])

  expect(main).toContain('"daw:export:pick-output-file"')
  expect(main).toContain('"daw:export:pick-output-directory"')
  expect(main).toContain('"daw:export:release-output"')
  expect(main).toContain("event.senderFrame === event.sender.mainFrame")
  expect(main).toContain("fileCapabilities.pickOutputFile")
  expect(main).toContain("fileCapabilities.revokeRequest(scope)")
  expect(preload).toContain("pickOutputFile(requestId")
  expect(preload).toContain("ipcRenderer.invoke(\"daw:export:pick-output-file\"")
  expect(preload).toContain("releaseExportOutput(requestId")
  expect(bridge).toContain("pickOutputDirectory")
  expect(context).toContain("import.meta.env.VITE_DESKTOP === 'true'")
  expect(context).toContain("createDesktopRendererExportOutputTargetFactory")
  expect(outputTarget).not.toContain("createWritable")
})
