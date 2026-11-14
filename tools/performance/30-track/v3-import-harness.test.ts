import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { createPrivateRunDirectory } from "./electron"
import { cleanupV3Run, ownedV3CdpEndpoint } from "./v3-import-acceptance"
import { processRows } from "./run-electron-process"

// An owned disposable Bun process supplies only a synthetic capability/listener,
// not Electron, a renderer or a plugin. Readiness is announced by a stdout event.
const fixture = `
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const profile = process.argv.find(value => value.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
if (process.argv.includes("--fixture-idle")) {
  process.stdin.resume();
  console.log("ready");
} else {
  const server = createServer(socket => socket.end());
  server.listen(0, "127.0.0.1", async () => {
    await writeFile(path.join(profile, "DevToolsActivePort"), server.address().port + "\\n/devtools/browser/12345678-1234-1234-1234-123456789abc\\n");
    console.log("ready");
  });
}
`

const launchFixture = async (idle = false) => {
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  await mkdir(profile, { mode: 0o700 })
  const script = path.join(directory, "fixture.ts")
  await Bun.write(script, fixture)
  const child = spawn(process.execPath, [script, "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...(idle ? ["--fixture-idle"] : [])], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  })
  const exited = once(child, "close")
  try {
    const [chunk] = await Promise.race([once(child.stdout, "data"), exited])
    expect(String(chunk).trim()).toBe("ready")
    if (!child.pid) throw new Error("Fixture PID unavailable")
    const pid = child.pid
    return {
      directory, profile, child, pid, exited,
      dispose: async () => {
        // This exact child was created here; never use a process-name match.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await exited
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    child.kill("SIGKILL")
    await exited
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test("owned v3 launch correlates capability, listener, root and cleanup without touching another process", async () => {
  const app = await launchFixture()
  let unrelated: Awaited<ReturnType<typeof launchFixture>> | undefined
  try {
    unrelated = await launchFixture(true)
    const unrelatedPid = unrelated.pid
    const launch = await ownedV3CdpEndpoint(app.profile, app.pid, process.execPath)
    expect(launch.endpoint).toStartWith("ws://127.0.0.1:")
    expect(launch.plan.rootPid).toBe(app.pid)
    expect(launch.plan.processGroupId).toBe(app.pid)
    expect(launch.plan.recordedProcesses.some(row => row.pid === app.pid)).toBe(true)
    expect((await processRows()).some(row => row.pid === app.pid)).toBe(true)
    const cleanup = await cleanupV3Run(app.directory, app.pid, process.execPath, launch.plan)
    expect(cleanup.removed).toBe(true)
    expect((await processRows()).some(row => row.pid === app.pid)).toBe(false)
    expect((await processRows()).some(row => row.pid === unrelatedPid)).toBe(true)
  } finally {
    await Promise.all([app.dispose(), unrelated?.dispose()])
  }
})

test("missing CDP readiness fails but pre-attachment v3 cleanup still terminates the owned app", async () => {
  const app = await launchFixture(true)
  try {
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, process.execPath)).rejects.toThrow("ENOENT")
    const cleanup = await cleanupV3Run(app.directory, app.pid, process.execPath)
    expect(cleanup.removed).toBe(true)
    expect((await processRows()).some(row => row.pid === app.pid)).toBe(false)
  } finally {
    await app.dispose()
  }
})

test("a copied CDP capability never establishes ownership of an unrelated listener", async () => {
  const app = await launchFixture(true)
  let unrelated: Awaited<ReturnType<typeof launchFixture>> | undefined
  try {
    unrelated = await launchFixture()
    const unrelatedPid = unrelated.pid
    await Bun.write(path.join(app.profile, "DevToolsActivePort"),
      await readFile(path.join(unrelated.profile, "DevToolsActivePort"), "utf8"))
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, process.execPath))
      .rejects.toThrow("owned by another process")
    expect((await cleanupV3Run(app.directory, app.pid, process.execPath)).removed).toBe(true)
    expect((await processRows()).some(row => row.pid === unrelatedPid)).toBe(true)
  } finally {
    await Promise.all([app.dispose(), unrelated?.dispose()])
  }
})

test("v3 readiness rejects wrong executable, profile and malformed capability", async () => {
  const app = await launchFixture()
  let other: Awaited<ReturnType<typeof launchFixture>> | undefined
  try {
    other = await launchFixture(true)
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, "/not-the-fixture"))
      .rejects.toThrow("executable identity")
    const capability = await readFile(path.join(app.profile, "DevToolsActivePort"), "utf8")
    await Bun.write(path.join(other.profile, "DevToolsActivePort"), capability)
    await expect(ownedV3CdpEndpoint(other.profile, app.pid, process.execPath))
      .rejects.toThrow("profile identity")
    await Bun.write(path.join(app.profile, "DevToolsActivePort"), "0\n/devtools/browser/invalid\n")
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, process.execPath))
      .rejects.toThrow("capability file is invalid")
    await Bun.write(path.join(app.profile, "DevToolsActivePort"), capability.replace("/devtools/browser/", "/not-a-browser/"))
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, process.execPath))
      .rejects.toThrow("browser target capability is invalid")
  } finally {
    await Promise.all([app.dispose(), other?.dispose()])
  }
})

test("v3 cleanup refuses a mismatched root and retains the still-in-use profile", async () => {
  const app = await launchFixture(true)
  try {
    const cleanup = await cleanupV3Run(app.directory, app.pid, "/not-the-fixture")
    expect(cleanup.removed).toBe(false)
    expect(cleanup.error).toBe("Runner profile is still in use.")
    expect((await processRows()).some(row => row.pid === app.pid)).toBe(true)
  } finally {
    await app.dispose()
  }
})

test("an exited root cannot be declared ready from its remaining capability file", async () => {
  const app = await launchFixture()
  try {
    app.child.kill("SIGTERM")
    await app.exited
    await expect(ownedV3CdpEndpoint(app.profile, app.pid, process.execPath))
      .rejects.toThrow("root process exited before attachment")
    expect((await cleanupV3Run(app.directory, app.pid, process.execPath)).removed).toBe(true)
  } finally {
    await app.dispose()
  }
})
