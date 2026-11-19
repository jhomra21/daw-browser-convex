# Spectrum device: packaged desktop check

Run on 2026-11-19 on the packaged desktop app built from `spectrum-analyzer` (after `232583bc`), with the AE-08 song v2 project ("Macros - Coming Soon (score v2)").

## What was exercised

Every change went through the control platform (preview, approval when required, keyed commit), driven by `scripts/e2e.ts` with `scripts/ctl.ts`. Screens were captured from the running app.

| Step | Result |
|---|---|
| Mixdown export before any change | `7c0e75dd…`, the recorded v2 export hash |
| `effect.upsert` Spectrum on the master and on Lead | r10 → r11, both persisted with `{ enabled: true, view: "both" }` |
| Mixdown export with both devices | `7c0e75dd…`, byte-identical |
| Play from 10 s with the Master selected | The Spectrum device draws the curve and the spectrogram (`master-device-playing.png`) |
| Play from 10 s with Pad selected | Pad's Spectrum device draws after its EQ, Auto Filter and Ensemble (`pad-device-playing.png`) |
| `effect.upsert` view = spectrogram on the master device | r11 → r12, persisted |
| `effect.remove` both devices | r12 → r13, none left |
| Mixdown export after removal | `7c0e75dd…`, byte-identical |
| App restart | The devices added before the restart were still in the chain |

## Bugs this check found, fixed on the branch

1. **`effect.upsert` with `spectrum` failed** with "Control planning failed.": the planner's per-kind param normalization threw for the new kind (`2118dddf`).
2. **The native master spectrum and master meter never worked.** The graph names the master node `$master` (`MASTER_ROUTE_TARGET`), but the renderer observed `nativeGraphNodeId("master")`. The host refused the master spectrum selection (`spectrumSelection` request 49 rejected) and master meter entries never matched, so the master EQ's spectrum, the master meter and a master Spectrum device stayed empty on the desktop. This predates the Spectrum device (`232583bc`). After the fix the master EQ also draws its spectrum (`master-device-playing.png`).

## Known limits

- The spectrogram clears when playback stops, because the frame stream delivers no frame while stopped.
- One analysed target at a time: the host computes one spectrum, for the track or master the device panel shows.

## Change after review

The first version also had an Analyzer tab in the bottom panel footer. It duplicated the device, so it was removed (`da75abde`); like Ableton's Spectrum, the analyzer is only a device in the chain. The Pad screenshot is from the package after that change: the footer shows Effects and Clip only.
