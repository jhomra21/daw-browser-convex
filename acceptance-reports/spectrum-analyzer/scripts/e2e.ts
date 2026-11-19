import { apply, snap, host, run } from "/tmp/spectrum-e2e/ctl.ts"
const step = process.argv[2]
const out = "/tmp/spectrum-e2e"
const exportTo = async (name: string) => {
  const path = `${out}/${name}.wav`
  await Bun.$`rm -f ${path}`
  const request = { mode: "mixdown", format: "wav", destination: { kind: "file", path }, range: { mode: "custom", startSec: 0, endSec: 29 }, render: { sampleRate: 48000, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } }, encoding: { wav: { codec: "pcm-s24", dither: "none" } } }
  await Bun.write(`${out}/${name}-request.json`, JSON.stringify(request))
  const r = await Bun.$`sh /tmp/spectrum-e2e/export.sh ${out}/${name}-request.json`.text()
  if (!r.includes('"completed"')) throw new Error(`export ${name}: ${r}`)
  console.log(`export ${name}: ${(await Bun.$`shasum -a 256 ${path}`.text()).split(" ")[0]}`)
}
const spectra = (s: any) => s.processors.filter((p: any) => p.processor.kind === "spectrum")
if (step === "before") await exportTo("before")
if (step === "add") {
  await apply("spectrum-add", (s) => [
    { kind: "effect.upsert", target: { kind: "master" }, effectKind: "spectrum" },
    { kind: "effect.upsert", target: { kind: "track", track: { source: "persisted", id: s.tracks.find((t: any) => t.name === "Lead")?.id ?? s.tracks[0].id } }, effectKind: "spectrum" },
  ])
  console.log(JSON.stringify(spectra(await snap()).map((p: any) => ({ target: p.target, params: p.processor.params }))))
}
if (step === "after") await exportTo("after")
if (step === "view") {
  await apply("spectrum-view", (s) => spectra(s).filter((p: any) => p.target.master).map((p: any) => ({ kind: "effect.upsert", target: { kind: "master" }, effect: { source: "persisted", id: p.id }, effectKind: "spectrum", params: { version: 1, state: { enabled: true, view: "spectrogram" } } })))
  console.log(JSON.stringify(spectra(await snap()).map((p: any) => p.processor.params)))
}
if (step === "remove") {
  await apply("spectrum-remove", (s) => spectra(s).map((p: any) => ({ kind: "effect.remove", target: p.target.master ? { kind: "master" } : { kind: "track", track: { source: "persisted", id: p.target.trackId } }, effectKind: "spectrum", effect: { source: "persisted", id: p.id } })))
  console.log("remaining", spectra(await snap()).length)
}
if (step === "status") console.log(JSON.stringify(await host("status")).slice(0, 600))
