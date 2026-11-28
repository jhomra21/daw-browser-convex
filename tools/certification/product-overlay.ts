import { plugin } from "bun"
import { appendFileSync, readFileSync } from "node:fs"
import { z } from "zod"

// FAST-CERT --overlay: a simulated product change, applied in memory to the bun processes FAST-CERT starts; nothing is written to
// disk. It is the first preload, and Bun runs only the first plugin whose onLoad filter matches a file, so for its own files it
// also applies the job's mutation spec on top (DV01_OVERLAY_FILE, with that overlay's marker), as the job's overlay would apply
// it to the changed file on disk. Every other file is left to the job's overlay. The edits use the RC overlays' semantics:
// `contentsFile` replaces the file, otherwise `from` must occur exactly once and String#replace applies `to`. Its own record goes
// to FAST_CERT_PRODUCT_LOG, not stdout, so judged logs (a campaign's log hash, a search's line count) see only the change itself.
const change = z.object({ file: z.string(), from: z.string().optional(), to: z.string().optional(), contentsFile: z.string().optional() })
const spec = z.object({ id: z.string(), changes: z.array(change), childPreload: z.boolean().optional() })
const readSpec = (file: string | undefined) => file ? spec.parse(JSON.parse(readFileSync(file, "utf8"))) : { id: "none", changes: [], childPreload: undefined }
const product = readSpec(process.env.FAST_CERT_PRODUCT_OVERLAY)
// BUN_OPTIONS puts this preload in every bun process a job starts, children included. The job's own mutation belongs to the process
// the job started, as with the RC overlays, unless its spec asks for its children too: the first process marks the environment.
const child = process.env.FAST_CERT_PRODUCT_ROOT !== undefined
process.env.FAST_CERT_PRODUCT_ROOT ??= String(process.pid)
const jobSpec = readSpec(process.env.DV01_OVERLAY_FILE)
const job = child && jobSpec.childPreload !== true ? { id: jobSpec.id, changes: [] } : jobSpec
const jobMarker = process.env.FAST_CERT_ARM_MARKER ?? ""
const productLog = process.env.FAST_CERT_PRODUCT_LOG ?? ""
const armPreload = process.env.FAST_CERT_ARM_PRELOAD ?? ""

const apply = (contents: string, edit: z.infer<typeof change>, id: string) => {
  if (edit.contentsFile) return readFileSync(edit.contentsFile, "utf8")
  if (edit.from === undefined || edit.to === undefined || contents.split(edit.from).length !== 2)
    throw new Error(`Overlay requires one exact anchor: ${id} ${edit.file}`)
  const to = edit.to
  return contents.replace(edit.from, () => to)
}
const escaped = product.changes.map((edit) => edit.file.replace(/^\/?/, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
// Jobs whose own preload appends a file (a bun plugin) never see a file this plugin loads first. The append runs here, on the
// file's effective contents (reverted when the revert replaced it). One row per appending job: the env var names the source it
// appends, the suffix names the file it appends to, and the marker is the line the job's judge counts in its log.
const appends = [{ sourceEnv: "DV01_B6F_PROBE", file: "/src/hooks/useTimelinePlayback.test.ts", marker: "DV01-B6F-PROBE-APPENDED" }]
plugin({ name: `fast-cert-product-${product.id}`, setup(build) {
  build.onLoad({ filter: new RegExp(`(${escaped.join("|")})$`) }, ({ path }) => {
    let contents = readFileSync(path, "utf8")
    for (const edit of product.changes.filter((entry) => path.endsWith(entry.file))) {
      contents = apply(contents, edit, product.id)
      if (productLog.length > 0) appendFileSync(productLog, `FAST-CERT-PRODUCT-OVERLAY-APPLIED ${product.id} ${edit.file} ${process.pid}\n`)
    }
    for (const edit of job.changes.filter((entry) => path.endsWith(entry.file))) {
      contents = apply(contents, edit, job.id)
      if (jobMarker.length > 0) console.log(jobMarker, job.id, edit.file)
    }
    // The arm overlay also makes the test spawn its bun child with that overlay as preload (the child is the second evaluation
    // of its marker). It cannot do so for a file this plugin loads first, so the same edit is made here.
    if (job.childPreload && armPreload.length > 0 && path.endsWith("/src/hooks/useTimelinePlayback.test.ts")) {
      const anchor = '"--conditions=browser", "-e", `'
      if (contents.split(anchor).length !== 2) throw new Error("Missing child preload anchor")
      contents = contents.replace(anchor, () => `"--conditions=browser", "--preload", ${JSON.stringify(armPreload)}, "-e", \``)
    }
    for (const { sourceEnv, file, marker } of appends) {
      const source = process.env[sourceEnv]
      if (!source || !path.endsWith(file)) continue
      contents += `\n${readFileSync(source, "utf8")}`
      console.log(marker)
    }
    return { contents, loader: path.endsWith(".tsx") ? "tsx" : path.endsWith(".js") ? "js" : "ts" }
  })
} })
