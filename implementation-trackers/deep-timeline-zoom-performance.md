# Deep Timeline Zoom Performance

## Status

**READY**. PR #54 is complete for the accepted deep-zoom scope. Safari automation is waived for this qualification and no production deployment is implied.

## Accepted architecture

- The arrangement uses a logical visible time range inside a bounded 200,000 px physical runway. The surface, ruler, grid, overlays, clips, automation, and playhead project from the logical viewport rather than project-duration-sized DOM coordinates.
- Scroll recentering changes only the physical proxy. Ruler and grid phases derive from the canonical logical visible start, pixels per second, and selected interval.
- Clips render only their visible intersection plus fixed overscan. Waveform canvases use current viewport geometry and native device-pixel backing dimensions.
- Retained waveform state stores bounded source representations, not raster geometry. Current clip timing and source data are projected through the canonical audio time map on each view change.
- Envelope, exact PCM line, and sample points share signed source geometry and the same sample-to-Y mapping. Point decoration is paint-only and does not create a separate acquisition identity.
- Arrangement PCM work is tiled, cancellable, prioritized, deduplicated, and bounded to two active decodes, 64 queued jobs, 32 MiB cache bytes, 8 MiB cache entries, and 128 cache entries.
- Peak persistence validates source metadata and chunks, publishes atomically after complete writes, and removes incomplete assets before regeneration.
- Browser event listeners, ResizeObservers, media-query listeners, stale generations, cancellation, and persistence failures are cleaned up or fail closed.

## Implementation history

- Wave A established logical viewport geometry, shared waveform LOD selection, channel-aware retained data, bounded source windows, and the arrangement scheduler.
- Wave B/C migrated arrangement consumers to the bounded runway and added viewport-relative projection, culling, grid/ruler phase, and interaction coverage.
- Later fixes hardened source identity, local descriptor caching, persisted peaks, scheduler admission, current-view waveform projection, and signed continuous rendering.
- The final cleanup retained the established behavior and removed unused diagnostics/API surface, redundant DPR ownership, and source-text-only assertions where direct behavioral coverage exists.

## Validation evidence

- Focused waveform, viewport, grid/ruler, timeline interaction, browser-condition, persistence, and renderer suites pass.
- Package/root/API/desktop typechecks, lint with zero warnings, anti-slop suites, production build, portable Wasm validation, Workers dry-run, Electron packaging, security scan, and `git diff --check` pass.
- Configured complete suite passed with 2,972 tests passing, one intentional portable-Wasm Electron skip, and zero failures.
- Packaged Electron qualification measured a 200,000 px runway, 12/12 nonzero canvases, zero renderer errors, and no in-campaign frame intervals at or above 16.67 ms, 50 ms, or 100 ms.
- Rebuilt Arrangement continuity capture measured zero blank frames and stable waveform thickness through overview, deep zoom, reverse zoom, playback, and return-to-overview sequences.
- Browser and packaged Electron evidence confirms pinned surface attachment, logical grid/ruler phase, current-view waveform projection, native-DPR rasterization, and continuous signed waveform geometry.

## Platform note

Safari 26.3 is installed, but Remote Automation is unavailable in this environment. No Chromium or Electron result is labeled as Safari. The user-approved Safari waiver is the accepted platform limitation for this qualification.
