import { z } from "zod"
import { writePrivateArtifact } from "./electron"

// Electron's main-process inspector is fused off in packaged builds, so the
// runner drives the owned window through macOS Accessibility (minimize) and an
// opaque cover window from a separate process (occlusion). Both act on OS
// window state only; the app receives no test-only API or throttling flags.
const minimizeScript = `ObjC.import('ApplicationServices')
function run(argv) {
  const app = $.AXUIElementCreateApplication(Number(argv[0]))
  const windowsRef = Ref()
  const listed = $.AXUIElementCopyAttributeValue(app, $('AXWindows'), windowsRef)
  if (listed !== 0) throw new Error('AXWindows unavailable: ' + listed)
  const windows = ObjC.castRefToObject(windowsRef[0])
  const count = Number(windows.count)
  if (count !== 1) throw new Error('Expected one owned window, found ' + count)
  const window = windows.objectAtIndex(0)
  const requested = argv[1] === 'true'
  const changed = $.AXUIElementSetAttributeValue(window, $('AXMinimized'), $.NSNumber.numberWithBool(requested))
  if (changed !== 0) throw new Error('AXMinimized write failed: ' + changed)
  // The (de)miniaturize animation completes asynchronously; poll the attribute for up to 3 s.
  let minimized = !requested
  for (let attempt = 0; attempt < 30 && minimized !== requested; attempt += 1) {
    if (attempt > 0) $.NSThread.sleepForTimeInterval(0.1)
    const minimizedRef = Ref()
    $.AXUIElementCopyAttributeValue(window, $('AXMinimized'), minimizedRef)
    minimized = ObjC.unwrap(ObjC.castRefToObject(minimizedRef[0]))
  }
  return JSON.stringify({ windows: count, minimized })
}`

const observeMinimizedScript = `ObjC.import('ApplicationServices')
function run(argv) {
  const app = $.AXUIElementCreateApplication(Number(argv[0]))
  const windowsRef = Ref()
  const listed = $.AXUIElementCopyAttributeValue(app, $('AXWindows'), windowsRef)
  if (listed !== 0) throw new Error('AXWindows unavailable: ' + listed)
  const windows = ObjC.castRefToObject(windowsRef[0])
  const count = Number(windows.count)
  if (count !== 1) throw new Error('Expected one owned window, found ' + count)
  const minimizedRef = Ref()
  const observed = $.AXUIElementCopyAttributeValue(windows.objectAtIndex(0), $('AXMinimized'), minimizedRef)
  if (observed !== 0) throw new Error('AXMinimized read failed: ' + observed)
  return JSON.stringify({ windows: count, minimized: ObjC.unwrap(ObjC.castRefToObject(minimizedRef[0])) })
}`

const coverScript = `ObjC.import('Cocoa')
function run(argv) {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  app.finishLaunching
  const screens = $.NSScreen.screens
  const windows = []
  for (let index = 0; index < Number(screens.count); index += 1) {
    const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(screens.objectAtIndex(index).frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false)
    window.opaque = true
    window.backgroundColor = $.NSColor.blackColor
    window.level = $.NSFloatingWindowLevel
    window.ignoresMouseEvents = true
    window.orderFrontRegardless
    windows.push(window)
  }
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5))
  console.log('covered ' + windows.length)
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(Number(argv[0])))
}`

const minimizedResultSchema = z.object({ windows: z.literal(1), minimized: z.boolean() }).strict()

const boundedExit = async (child: Bun.Subprocess, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })
  const result = await Promise.race([child.exited, timedOut])
  clearTimeout(timer)
  if (result !== "timeout") return result
  child.kill("SIGKILL")
  await child.exited
  return null
}

const setMinimized = async (pid: number, minimized: boolean) => {
  const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", minimizeScript, String(pid), String(minimized)], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), boundedExit(child, 10_000),
  ])
  if (exitCode !== 0) throw new Error(`Owned window minimize=${minimized} failed: ${(stderr || "timed out").trim().slice(0, 256)}`)
  const result = minimizedResultSchema.parse(JSON.parse(stdout))
  if (result.minimized !== minimized) throw new Error(`Owned window reported minimized=${result.minimized} after requesting ${minimized}.`)
}

const observeMinimized = async (pid: number) => {
  const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", observeMinimizedScript, String(pid)], {
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), boundedExit(child, 10_000),
  ])
  if (exitCode !== 0) throw new Error(`Owned window minimized observation failed: ${(stderr || "timed out").trim().slice(0, 256)}`)
  return minimizedResultSchema.parse(JSON.parse(stdout))
}

const startCover = async (maxSeconds: number) => {
  const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", coverScript, String(maxSeconds)], { stdout: "ignore", stderr: "pipe" })
  const reader = child.stderr.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 10_000) })
  try {
    while (!/covered [1-9]\d*/.test(output)) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === "timeout" || next.done) throw new Error(`Occluding window did not appear: ${output.trim().slice(0, 256)}`)
      output += decoder.decode(next.value)
    }
  } catch (error) {
    child.kill("SIGKILL")
    await child.exited
    throw error
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  const match = output.match(/covered ([1-9]\d*)/)
  if (!match?.[1]) throw new Error("Occluding window screen count is missing.")
  const screensCovered = Number(match[1])
  const startedAt = performance.now()
  return {
    screensCovered,
    async remove() {
      child.kill("SIGTERM")
      await boundedExit(child, 3_000)
      return { intervalMs: performance.now() - startedAt }
    },
  }
}

export type RecordingWindowState = "minimized" | "occluded"
export type RecordingWindowObservation = {
  state: RecordingWindowState
  minimized?: boolean
  screensCovered?: number
  intervalMs?: number
}

export const createOwnedWindowControl = (pid: number, mainSamplePath?: string) => {
  let minimized = false
  let cover: Awaited<ReturnType<typeof startCover>> | undefined
  return {
    observe: () => observeMinimized(pid),
    async enter(state: RecordingWindowState, maxSeconds: number) {
      if (minimized || cover) throw new Error("Owned window is already backgrounded.")
      if (state === "minimized") {
        minimized = true
        // Diagnostic-only sampling of the verified runner-owned root PID.
        // Never changes app priority/throttling; sampled runs are not benchmarks.
        const sampler = mainSamplePath
          ? Bun.spawn(["sample", String(pid), "2", "5", "-file", mainSamplePath], { stdout: "ignore", stderr: "pipe" })
          : undefined
        try {
          await setMinimized(pid, true)
        } finally {
          if (sampler && mainSamplePath) {
            const [stderr, exitCode] = await Promise.all([
              new Response(sampler.stderr).text(), boundedExit(sampler, 6_000),
            ])
            await writePrivateArtifact(`${mainSamplePath}.status.json`, JSON.stringify({
              exitCode, stderr: stderr.slice(-1_000), interpretation: "Diagnostic sampling; not frame-performance evidence.",
            }))
          }
        }
        return { state, minimized: true } satisfies RecordingWindowObservation
      }
      cover = await startCover(maxSeconds)
      return { state, screensCovered: cover.screensCovered } satisfies RecordingWindowObservation
    },
    async restore() {
      const activeCover = cover
      cover = undefined
      let restoredMinimized = false
      let coveredIntervalMs: number | undefined
      if (activeCover) {
        coveredIntervalMs = (await activeCover.remove()).intervalMs
        if (coveredIntervalMs < 1) throw new Error("Owned cover window interval was not observed.")
      }
      if (minimized) {
        await setMinimized(pid, false)
        minimized = false
        restoredMinimized = true
      }
      return { minimized: restoredMinimized, coveredIntervalMs }
    },
  }
}
export type OwnedWindowControl = ReturnType<typeof createOwnedWindowControl>
