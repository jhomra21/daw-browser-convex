#!/usr/bin/env bun
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const root = path.resolve(import.meta.dir, "../../..")
const harness = path.join(import.meta.dir, "v3-import-acceptance.ts")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const variantSchema = z.enum(["V0", "V1", "V4", "V8", "V8A", "V8Z"])
const isBenchmarkProcess = (command: string) => (
  command.includes(".app/Contents/MacOS/@daw-browser-desktop")
  || /(?:^|\/)daw-audio-host-macos(?:\s|$)/.test(command)
  || /(?:^|\/)daw-vst3-worker(?:\s|$)/.test(command)
)

const processRows = async () => {
  const process = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,%cpu=,rss=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(process.stdout).text()
  if (await process.exited !== 0) throw new Error("Could not inspect benchmark processes.")
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      cpuPercent: Number(match[4]),
      rssBytes: Number(match[5]) * 1024,
      threadCount: null,
      command: match[6] ?? "",
    }]
  })
}

const relatedProcesses = async () => (await processRows()).filter((row) => isBenchmarkProcess(row.command))

const configuration = (variant: z.infer<typeof variantSchema>) => {
  if (variant === "V0") return { count: 0, stress: false }
  if (variant === "V1") return { count: 1, stress: false }
  if (variant === "V4") return { count: 4, stress: false }
  if (variant === "V8Z") return { count: 8, stress: true }
  return { count: 8, stress: false }
}

const main = async () => {
  const variant = variantSchema.parse(Bun.argv[2])
  const attempts = z.coerce.number().int().positive().max(100).parse(Bun.argv[3] ?? "10")
  const outputDirectory = Bun.argv[4]
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) {
    throw new Error("Usage: bun vst-reliability.ts <V0|V1|V4|V8|V8A|V8Z> <attempts> <absolute-output-directory>")
  }
  await mkdir(outputDirectory, { recursive: true })
  const config = configuration(variant)
  const results = []
  let activeChild: ReturnType<typeof Bun.spawn> | null = null
  let interruptedSignal: NodeJS.Signals | null = null
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal
    activeChild?.kill(signal)
  }
  const interruptSigint = () => interrupt("SIGINT")
  const interruptSigterm = () => interrupt("SIGTERM")
  process.once("SIGINT", interruptSigint)
  process.once("SIGTERM", interruptSigterm)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await relatedProcesses()
    if (before.length > 0) throw new Error(`Attempt ${attempt} did not start clean: ${JSON.stringify(before)}`)
    const artifactPath = path.join(outputDirectory, `${variant.toLowerCase()}-${attempt}.json`)
    const samples: Awaited<ReturnType<typeof processRows>> = []
    const child = Bun.spawn([
      "bun", harness, artifactPath, "--vst-reliability", String(config.count),
      ...(config.stress ? ["zoom"] : []),
    ], {
      cwd: root,
      env: { ...process.env, DAW_BENCHMARK_VST_AUTOMATION: variant === "V8A" ? "1" : "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    activeChild = child
    let output = ""
    void new Response(child.stdout).text().then((value) => { output += value })
    void new Response(child.stderr).text().then((value) => { output += value })
    while (child.exitCode === null) {
      samples.push(...(await processRows()).filter((row) => isBenchmarkProcess(row.command)))
      await delay(250)
    }
    await child.exited
    activeChild = null
    await delay(1_000)
    const after = await relatedProcesses()
    const artifact = await readFile(artifactPath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(() => null)
    results.push({
      attempt,
      status: artifact?.status ?? "failed",
      stage: artifact?.stage ?? "artifact",
      error: artifact ? artifact.error ?? null : `Harness exited without writing ${artifactPath}.`,
      diagnostics: artifact?.postmortem ?? null,
      processSamples: samples.slice(-2_000),
      cleanup: { before, after, clean: before.length === 0 && after.length === 0 },
      outputTail: output.slice(-4_000),
    })
    if (after.length > 0) throw new Error(`Attempt ${attempt} leaked owned processes: ${JSON.stringify(after)}`)
    if (interruptedSignal) break
  }
  process.off("SIGINT", interruptSigint)
  process.off("SIGTERM", interruptSigterm)
  const summary = {
    variant,
    attempts,
    successes: results.filter((result) => result.status === "complete").length,
    failures: results.filter((result) => result.status !== "complete").length,
    results,
  }
  await Bun.write(path.join(outputDirectory, `${variant.toLowerCase()}-summary.json`), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2))
  if (interruptedSignal) process.exitCode = 128 + (interruptedSignal === "SIGINT" ? 2 : 15)
}

if (import.meta.main) await main()
