import path from "node:path"

const root = "/Users/juan/Documents/daw-browser-convex"
export const profile = "/tmp/song/profile"
const cli = path.join(root, "packages/control-cli/src/index.ts")
const env = { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") }

export const run = async (args: string[], input?: unknown): Promise<any> => {
  const child = Bun.spawn(["bun", cli, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe" })
  if (input !== undefined && child.stdin) { child.stdin.write(`${JSON.stringify(input)}\n`); child.stdin.end() }
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  if (code !== 0) throw new Error(`daw-control ${args.join(" ")} exited ${code}: ${(err || out).slice(0, 3000)}`)
  return JSON.parse(out).data
}

export const host = (...args: string[]) => run(["host", ...args])
export const projectId = async (): Promise<string> => (await run(["project", "current", "--target", "host"])).project.projectId
export const snap = async () => run(["snapshot-v2", await projectId(), "--target", "host"])

// Song time: beat 0 of the score sits 0.1 s into the trailer, at 120 BPM.
export const T = (beat: number) => Number((0.1 + 0.5 * beat).toFixed(4))

export const ref = (id: string) => ({ source: "persisted", id })
export const track = (s: any, name: string) => {
  const found = s.tracks.find((t: any) => t.name === name)
  if (!found) throw new Error(`No track named ${name}`)
  return found
}
export const trackRef = (s: any, name: string) => ref(track(s, name).id)
export const processors = (s: any, name: string) => s.processors.filter((p: any) => p.target.trackId === track(s, name).id)
export const effect = (s: any, name: string | "master", kind: string) => {
  const list = name === "master" ? s.processors.filter((p: any) => p.target.master) : processors(s, name)
  const found = list.find((p: any) => p.processor.kind === kind)
  if (!found) throw new Error(`No ${kind} on ${name}`)
  return found
}
export const asset = (s: any, name: string) => {
  const found = s.assets.find((a: any) => a.name === name || a.name === `${name}.wav`)
  if (!found) throw new Error(`No asset ${name}`)
  return found
}
export const sample = (a: any) => ({
  assetKey: a.id, url: `local-asset:${a.id}`, name: a.name, sourceKind: a.sourceKind,
  source: { durationSec: a.durationSec, sampleRate: a.sampleRate, channelCount: a.channelCount },
})

export const apply = async (name: string, build: (s: any) => unknown[] | Promise<unknown[]>) => {
  for (let attempt = 0; ; attempt++) {
    const s = await snap()
    const actions = await build(s)
    const request = { version: "v1", projectId: s.project.id, expectedRevision: s.project.revision, actions }
    const preview = await run(["preview", "--request", "-", "--target", "host"], request)
    const approvalToken = preview.approval?.required
      ? (await run(["approval", "--request", "-", "--target", "host"], request)).approvalToken
      : undefined
    try {
      const commit = await run(["commit", "--request", "-", "--target", "host"],
        { ...request, idempotencyKey: `song-${name}-r${s.project.revision}`, ...(approvalToken ? { approvalToken } : {}) })
      console.log(`${name}: r${commit.priorRevision} -> r${commit.revision} applied=${commit.applied} ${commit.changeSummary.changes.map((c: any) => c.description).join(" | ").slice(0, 800)}`)
      return commit
    } catch (error) {
      if (attempt < 2 && String(error).includes("revision-conflict")) { console.log(`${name}: revision conflict, rebuilding from a fresh snapshot`); continue }
      throw error
    }
  }
}
