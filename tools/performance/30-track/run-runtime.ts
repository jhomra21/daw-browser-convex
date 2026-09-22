import { collectBrowserProbe } from "./probe"

void collectBrowserProbe(30).then((result) => {
  Object.defineProperty(window, "__thirtyTrackProbeResult", { configurable: true, value: result })
// oxlint-disable-next-line anti-slop/no-unknown-parameters
}).catch((error: unknown) => {
  Object.defineProperty(window, "__thirtyTrackProbeResult", {
    configurable: true,
    value: { error: error instanceof Error ? error.message : String(error) },
  })
})
