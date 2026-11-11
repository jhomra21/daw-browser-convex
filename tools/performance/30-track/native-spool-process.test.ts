import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { stopOwnedSpoolProcesses } from "./native-spool-process"

test("owned process termination never removes a retained spool/profile", async () => {
  const directory = `/tmp/daw-spool-preserve-test-${crypto.randomUUID()}`
  await mkdir(`${directory}/profile/recording-spool`, { recursive: true })
  const retained = `${directory}/profile/recording-spool/retained-fixture.pcm`
  await writeFile(retained, "retained")
  const row = { pid: 123, parentPid: 1, processGroupId: 123,
    command: `/fixture/app --user-data-dir=${directory}/profile` }
  const signals: string[] = []
  let reads = 0
  const result = await stopOwnedSpoolProcesses({
    directory, rootPid: 123, executable: "/fixture/app",
    inspect: async () => ++reads === 1 ? [row] : [],
    signal: (_pid, signal) => { signals.push(signal) }, wait: async () => undefined,
  })
  expect(result).toBe(true)
  expect(signals).toEqual(["SIGTERM"])
  expect(await readFile(retained, "utf8")).toBe("retained")
})
test("unknown process ownership is never terminated", async () => {
  const signals: string[] = []
  expect(await stopOwnedSpoolProcesses({
    directory: "/tmp/daw-owned", rootPid: 123, executable: "/fixture/app",
    inspect: async () => [{ pid: 123, parentPid: 1, processGroupId: 999, command: "/unrelated/app" }],
    signal: (_pid, signal) => { signals.push(signal) }, wait: async () => undefined,
  })).toBe(false)
  expect(signals).toEqual([])
})
test("executable and profile prefix collisions never establish owned termination", async () => {
  for (const command of ["/fixture/app-unrelated --user-data-dir=/tmp/daw-owned/profile",
    "/fixture/app --user-data-dir=/tmp/daw-owned/profile-other"]) {
    const signals: string[] = []
    expect(await stopOwnedSpoolProcesses({ directory: "/tmp/daw-owned", rootPid: 123, executable: "/fixture/app",
      inspect: async () => [{ pid: 123, parentPid: 1, processGroupId: 123, command }],
      signal: (_pid, signal) => { signals.push(signal) }, wait: async () => undefined })).toBe(false)
    expect(signals).toEqual([])
  }
})
test("shared group with an unproven member is never group-terminated", async () => {
  const signals: string[] = []
  expect(await stopOwnedSpoolProcesses({ directory: "/tmp/daw-owned", rootPid: 123, executable: "/fixture/app",
    inspect: async () => [
      { pid: 123, parentPid: 1, processGroupId: 123, command: "/fixture/app --user-data-dir=/tmp/daw-owned/profile" },
      { pid: 124, parentPid: 1, processGroupId: 123, command: "/unrelated/app" }],
    signal: (_pid, signal) => { signals.push(signal) }, wait: async () => undefined })).toBe(false)
  expect(signals).toEqual([])
})
test("a reused PID in another group is never escalated to SIGKILL", async () => {
  const signals: string[] = []
  let inspections = 0
  const row = { pid: 123, parentPid: 1, processGroupId: 123, command: "/fixture/app --user-data-dir=/tmp/daw-owned/profile" }
  await stopOwnedSpoolProcesses({ directory: "/tmp/daw-owned", rootPid: 123, executable: "/fixture/app",
    inspect: async () => [{ ...row, processGroupId: ++inspections === 1 ? 123 : 999 }],
    signal: (_pid, signal) => { signals.push(signal) }, wait: async () => undefined })
  expect(signals).toEqual(["SIGTERM"])
})
