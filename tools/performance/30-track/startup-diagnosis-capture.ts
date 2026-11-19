#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, openSync, writeSync, closeSync } from "node:fs"
import { lstat, open, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const runner = path.join(root, "tools/performance/30-track/late-commit-packaged-acceptance.ts")
const observer = path.join(root, "tools/performance/30-track/late-commit-observer.ts")
const runtime = path.join(root, "tools/performance/30-track/late-commit-observation-runtime.ts")
const cli = path.join(root, "packages/control-cli/dist/daw-control.js")
const asar = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources/app.asar")
const helpers = [
  "tools/performance/browser-harness.ts",
  "tools/performance/30-track/electron.ts",
  "tools/performance/30-track/v3-import-acceptance.ts",
  "tools/performance/30-track/v3-import-workload.ts",
  "tools/performance/30-track/native-spool-process.ts",
  "tools/performance/30-track/native-acceptance-ui.ts",
  "tools/performance/30-track/v3-import-process.ts",
  "tools/performance/30-track/native-spool-observer.ts",
  "tools/performance/30-track/renderer-profile.ts",
  "apps/desktop/quiet-renderer-telemetry.ts",
  "packages/control/package.json",
  "packages/control/src/actions.ts",
  "packages/control/src/index.ts",
  "packages/control/src/operations.ts",
  "packages/control/src/primitives.ts",
  "packages/control/src/recovery.ts",
  "packages/control/src/recovery-limits.ts",
  "packages/control/src/resumable-upload-limits.ts",
  "packages/control/src/serialization.ts",
  "packages/control/src/snapshots.ts",
  "packages/control/src/versions.ts",
  "packages/desktop-protocol/package.json",
  "packages/desktop-protocol/src/application-menu.ts",
  "packages/desktop-protocol/src/client-identity.ts",
  "packages/desktop-protocol/src/client.ts",
  "packages/desktop-protocol/src/diagnostics-v2.ts",
  "packages/desktop-protocol/src/index.ts",
  "packages/desktop-protocol/src/native-audio-host.ts",
  "packages/desktop-protocol/src/reply-chunks.ts",
  "packages/desktop-protocol/src/socket.ts",
  "node_modules/@electron/asar/package.json",
  "node_modules/@electron/asar/lib/asar.js",
  "node_modules/@electron/asar/lib/filesystem.js",
  "package.json",
  "bun.lock",
].map((file) => path.join(root, file))

const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
const append = (fd: number, value: Buffer | string) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
}
const freezeSchema = z.object({
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
}).strict()
const privateRegularFile = async (file: string, allowEmpty: boolean) => {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== (process.getuid?.() ?? -1)
    || (stat.mode & 0o777) !== 0o600 || (!allowEmpty && stat.size === 0))
    throw new Error("Private capture file ownership invalid.")
}

const main = async () => {
  const args = Bun.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log("Future execution only: --execute-future-private <owner-only-dir> <approved-profile> <reviewed-freeze-SHA256>")
    return
  }
  if (args.length !== 4 || args[0] !== "--execute-future-private"
    || !args[1] || !path.isAbsolute(args[1]) || !args[2] || !path.isAbsolute(args[2])
    || !args[3] || !/^[a-f0-9]{64}$/.test(args[3]))
    throw new Error("Future private capture requires an explicit owner-only directory, approved profile, and reviewed freeze digest.")
  const [, directory, profile, expectedFreeze] = args
  if (!directory || !profile || !expectedFreeze) throw new Error("Incomplete future private capture arguments.")
  const outputDirectory = await lstat(directory)
  if (!outputDirectory.isDirectory() || outputDirectory.uid !== (process.getuid?.() ?? -1)
    || (outputDirectory.mode & 0o777) !== 0o700 || await realpath(directory) !== directory)
    throw new Error("Precreated canonical owner-only capture directory required.")
  const frozenFiles = [runner, observer, runtime, cli, asar, ...helpers, fileURLToPath(import.meta.url)]
  const freezePath = path.join(directory, "approved-source-freeze.json")
  await privateRegularFile(freezePath, false)
  if (await digest(freezePath) !== expectedFreeze)
    throw new Error("Future capture freeze manifest digest mismatch.")
  const parsedFreeze = freezeSchema.safeParse(JSON.parse(await readFile(freezePath, "utf8")))
  const relativeFiles = frozenFiles.map((file) => path.relative(root, file))
  if (!parsedFreeze.success || parsedFreeze.data.files.length !== frozenFiles.length
    || parsedFreeze.data.files.some((entry, index) => entry.path !== relativeFiles[index]))
    throw new Error("Future capture freeze manifest does not match the fixed source inventory.")
  const expected = parsedFreeze.data.files.map((entry) => entry.sha256)
  const actual = await Promise.all(frozenFiles.map(digest))
  if (actual.some((value, index) => value !== expected[index]))
    throw new Error("Future capture frozen source/package identity mismatch.")
  const expectedAsar = expected[4]
  if (!expectedAsar) throw new Error("Future capture package identity is missing.")

  const resultPath = path.join(directory, "startup-diagnosis.json")
  const stdoutPath = path.join(directory, "runner.stdout")
  const stderrPath = path.join(directory, "runner.stderr")
  const exitPath = path.join(directory, "runner.exit.json")
  const manifestPath = path.join(directory, "capture-manifest.json")
  const manifest = await open(manifestPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  await manifest.writeFile(JSON.stringify({
    frozenSha256: Object.fromEntries(frozenFiles.map((file, index) => [relativeFiles[index], actual[index]])),
  }))
  await manifest.close()
  const result = await open(resultPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const stdout = await open(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const stderr = await open(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const exit = await open(exitPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  await Promise.all([result.close(), stdout.close(), stderr.close(), exit.close()])
  await Promise.all([resultPath, stdoutPath, stderrPath, exitPath].map((file) => privateRegularFile(file, true)))

  const stdoutFd = openSync(stdoutPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  const stderrFd = openSync(stderrPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  const exitFd = openSync(exitPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  let runnerExitRecorded = false
  let stdoutEnded = false
  let stderrEnded = false
  let stdoutClosed = false
  let stderrClosed = false
  const closeStream = (stream: "stdout" | "stderr") => {
    if (stream === "stdout" && !stdoutClosed) {
      stdoutClosed = true
      closeSync(stdoutFd)
    }
    if (stream === "stderr" && !stderrClosed) {
      stderrClosed = true
      closeSync(stderrFd)
    }
  }
  let finalized = false
  const finalizeWhenDrained = () => {
    if (!runnerExitRecorded || !stdoutEnded || !stderrEnded || finalized) return
    finalized = true
    closeStream("stdout")
    closeStream("stderr")
    closeSync(exitFd)
  }
  const markStreamEnded = (stream: "stdout" | "stderr") => {
    if (stream === "stdout") stdoutEnded = true
    else stderrEnded = true
    finalizeWhenDrained()
  }
  const child = spawn("bun", [runner, "--diagnose-startup", resultPath, profile, expectedAsar], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  })
  stdoutEnded = child.stdout === null
  stderrEnded = child.stderr === null
  child.stdout?.on("data", (chunk: Buffer) => { if (!stdoutClosed) append(stdoutFd, chunk) })
  child.stderr?.on("data", (chunk: Buffer) => { if (!stderrClosed) append(stderrFd, chunk) })
  child.stdout?.once("end", () => markStreamEnded("stdout"))
  child.stderr?.once("end", () => markStreamEnded("stderr"))
  child.stdout?.once("close", () => markStreamEnded("stdout"))
  child.stderr?.once("close", () => markStreamEnded("stderr"))
  child.once("error", () => {
    if (runnerExitRecorded) return
    append(exitFd, JSON.stringify({ spawnFailed: true }) + "\n")
    runnerExitRecorded = true
    finalizeWhenDrained()
    child.unref()
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    if (runnerExitRecorded) return
    append(exitFd, JSON.stringify({ exitCode: code, signaled: signal !== null }) + "\n")
    runnerExitRecorded = true
    finalizeWhenDrained()
    child.unref()
    process.exitCode = code === 0 && signal === null ? 0 : 1
  })
}

if (import.meta.main) {
  try { await main() } catch {
    console.error("Future private startup capture preflight failed; no runner was launched.")
    process.exitCode = 1
  }
}
