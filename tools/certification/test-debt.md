# Test debt: mutation arms recorded as expected survivors

Written 2026-11-10 by TEST-TIERS. FAST-CERT no longer runs these arms (`retiredArms` in tiers.ts). Each one mutated the product and exited 0 in the RC7 record: no test, fuzz seed, analyzer oracle or compile error noticed. They pin a known gap; running them verified nothing. 74 mutant arms are listed (69 survivors, 2 surviving MISMATCH arms and 3 "no witness" arms); 74 controls that existed only to qualify them were retired with them.

The MISMATCH rows 382 and 434 keep their killing arms and have no survivor to retire. Row 169 keeps `PARENT-RULING-RC6-STOP-513.md` item 3 and still runs. The rest are retired below under `acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-TEST-TIERS-ACCEPTED.md` ("MISMATCH rows"). A debt closes when a witness is added that fails the mutant; restore the arm then (it is still in expectations.json).

| Arm | Row | Mutates | Why it survives |
|---|---|---|---|
| `rc2:265:0:mutant` | rc2 265 | `src/lib/desktop/native-processor-state-owner.ts`: `// A submitted state patch, ordered by its edit. Its enabled flag and tail are the // proc` → `// A submitted state patch, ordered by its edit. Its enabled flag and tail are the // proc` | its test command (9 pass) still passes; row disposition "survives (source deletion, accepted)" |
| `rc2:266:0:mutant` | rc2 266 | `src/lib/desktop/native-playback-controller.ts`: ` if (action === "retry") void sendExecution({ ...resendRequest(execution), resent: executi` → ` if (action === "retry") void sendExecution(resendRequest(execution), true, execution)` | its test command (1 pass) still passes; row disposition "survives (source deletion, accepted)" |
| `rc2:267:0:mutant` | rc2 267 | `src/lib/desktop/native-playback-controller.ts`: ` state?: Uint8Array values: Readonly<Record<string, number>> desired?: ProcessorDesired ed` → ` state?: Uint8Array values: Readonly<Record<string, number>> desired?: ProcessorDesired ed` | its test command (1 pass) still passes; row disposition "survives (source deletion, accepted)" |
| `rc2:279:0:mutant` | rc2 279 | `src/lib/desktop/native-processor-state-owner.ts`: ` for (const execution of target.inflight.values()) if (!execution.sent) execution.epoch = ` → `` | its test command (705 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:279:2:mutant` | rc2 279 | `src/lib/desktop/native-processor-state-owner.ts`: ` for (const execution of target.inflight.values()) if (!execution.sent) execution.epoch = ` → `` | the fuzz seed 1 still passes; row disposition "survives (diagnostic)" |
| `rc2:388:1:mutant` | rc2 388 | `src/lib/desktop/native-processor-state-owner.ts`: ` if (evidence !== "cancelled" \|\| (target.queuedPatch && execution !== target.queuedPatch` → ` if (true) settle(execution, "cancelled", false)` | the fuzz seed 989 still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:389:1:mutant` | rc2 389 | `src/lib/desktop/native-playback-controller.ts`: ` \|\| refreshed.snapshot.assets.some((asset) => !installedSources.has(asset.assetId)) ` → `` | the fuzz seed 107 still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:392:1:mutant` | rc2 392 | `src/lib/desktop/native-processor-state-owner.ts`: ` for (const execution of target.inflight.values()) if (execution.sent && execution.values.` → `` | the fuzz seed 949 still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:393:1:mutant` | rc2 393 | `src/lib/desktop/native-processor-state-owner.ts`: ` else { execution.values = carried resends.push(execution) }` → ` else { resends.push(execution) }` | the fuzz seed 620 still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:398:0:mutant` | rc2 398 | `src/lib/desktop/native-processor-state-owner.ts`: ` if (execution.sent && execution.values.has(id) && execution.values.get(id) !== value) ret` → ` if (execution.values.has(id) && execution.values.get(id) !== value) return true` | its test command (20 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:398:1:mutant` | rc2 398 | `src/lib/desktop/native-processor-state-owner.ts`: ` if (execution.sent && execution.values.has(id) && execution.values.get(id) !== value) ret` → ` if (execution.values.has(id) && execution.values.get(id) !== value) return true` | the fuzz seed 949 still passes; row disposition "survives (diagnostic)" |
| `rc2:398:2:mutant` | rc2 398 | `src/lib/desktop/native-processor-state-owner.ts`: ` if (execution.sent && execution.values.has(id) && execution.values.get(id) !== value) ret` → ` if (execution.values.has(id) && execution.values.get(id) !== value) return true` | its test command (705 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:399:1:mutant` | rc2 399 | `src/lib/desktop/native-processor-state-owner.ts`: ` if (!execution \|\| !execution.receipts.some(receipt => record.cohort.has(receipt)) \|\| ` → ` if (execution && execution.receipts.some(receipt => record.cohort.has(receipt)) && eviden` | the fuzz seed 989 still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:400:0:mutant` | rc2 400 | `src/lib/desktop/native-playback-controller.ts`: `if (!result.handled && execution.attempt === attempt && execution.state` → `if (!result.handled && execution.state` | its test command (20 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:400:1:mutant` | rc2 400 | `src/lib/desktop/native-playback-controller.ts`: `if (!result.handled && execution.attempt === attempt && execution.state` → `if (!result.handled && execution.state` | its test command (705 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:400:2:mutant` | rc2 400 | `src/lib/desktop/native-playback-controller.ts`: `if (!result.handled && execution.attempt === attempt && execution.state` → `if (!result.handled && execution.state` | the fuzz seed 989 still passes; row disposition "survives (diagnostic)" |
| `rc2:408:0:mutant` | rc2 408 | `src/hooks/useTimelinePlayback.ts`: `if (!resumePlayback && nativePlayback.getPendingStart()?.mode === "preview") return true` → `if (nativePlayback.getPendingStart()?.mode === "preview") return true` | its test command (6 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:420:0:mutant` | rc2 420 | `src/hooks/useTimelinePlayback.ts`: ` // A locate superseded this Play on the prepared graph. A locate never cancels Play: play` → `` | its test command (12 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:422:0:mutant` | rc2 422 | `src/hooks/useTimelinePlayback.ts`: `requiresNativeAudio && nativePreviewRequested && playAttempt` → `requiresNativeAudio && playAttempt` | its test command (16 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:422:1:mutant` | rc2 422 | `src/hooks/useTimelinePlayback.ts`: `requiresNativeAudio && nativePreviewRequested && playAttempt` → `requiresNativeAudio && playAttempt` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:428:0:mutant` | rc2 428 | `src/hooks/useTimelinePlayback.ts`: `[cancellation, playAttempt?.promise, rebuildPromise]` → `[cancellation]` | its test command (21 pass) still passes; row disposition "DISPOSITION CHANGED" |
| `rc2:429:0:mutant` | rc2 429 | `src/hooks/useTimelinePlayback.ts`: ` if (nativePreviewRequested && await nativePlayback.ensureLivePreview(untrack(playheadSec)` → ` if (await nativePlayback.ensureLivePreview(untrack(playheadSec)) === "started") return ` | its test command (21 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:429:2:mutant` | rc2 429 | `src/hooks/useTimelinePlayback.ts`: ` if (nativePreviewRequested && await nativePlayback.ensureLivePreview(untrack(playheadSec)` → ` if (await nativePlayback.ensureLivePreview(untrack(playheadSec)) === "started") return ` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:429:3:mutant` | rc2 429 | `src/hooks/useTimelinePlayback.ts`: ` if (nativePreviewRequested && await nativePlayback.ensureLivePreview(untrack(playheadSec)` → ` if (await nativePlayback.ensureLivePreview(untrack(playheadSec)) === "started") return ` | its test command (16 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:433:0:mutant` | rc2 433 | `src/hooks/useTimelinePlayback.ts`: ` if (!mounted \|\| requestedIntentToken !== transportIntentToken) { setIsPlayPending(false` → ` if (!mounted \|\| requestedIntentToken !== transportIntentToken) return ` | its test command (21 pass) still passes; row disposition "survives (diagnostic)" |
| `rc2:437:1:mutant` | rc2 437 | `src/hooks/useTimelinePlayback.ts`: ` const hadPendingPlay = playAttempt !== undefined \|\| rebuildInProgress invalidatePlayAtt` → ` const hadPendingPlay = playAttempt !== undefined invalidatePlayAttempt() if (!isPlaying()` | its test command (2 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:439:mutant:hookwit` | ledger 439 | `src/hooks/useTimelinePlayback.ts`: ` if (rebuildInProgress) void cancelStartKeepingGraph("pause-superseded-rebuild", pauseProm` → `` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:440:mutant:hookwit` | ledger 440 | `src/hooks/useTimelinePlayback.ts`: ` const cancellation = after ? disposeNativePreview(undefined, reason, after) : disposePrep` → ` const cancellation = disposePreparedBackends(undefined, reason) ` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:441:mutant:p1-audiosync` | ledger 441 | `src/lib/portable-browser-playback-controller.ts`: ` if (request.edit && !(prepared && edited && isLiveParameterChange({ targetId: node.id, ef` → ` if (request.edit && !(prepared && edited)) { ` | its test command (3 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:442:mutant:p1-audiosync` | ledger 442 | `src/lib/portable-browser-playback-controller.ts`: ` if (edited) rememberInstrumentParameters(node.id, edited) ` → `` | its test command (3 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:443:mutant:p1-controller` | ledger 443 | `src/components/timeline/create-effects-panel-state.ts`: ` ? context.applyPortableProcessor(edit).then(() => applied) ` → ` ? applied ` | its test command (7 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:444:mutant:p1-audiosync` | ledger 444 | `src/components/Timeline.tsx`: `` → `` | its test command (3 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:450:mutant:hookwit` | ledger 450 | `src/hooks/useTimelinePlayback.ts`: ` if (seekSequence !== nativeSeekSequence) setPlayhead(playheadSec(), tracks) ` → ` if (backend === 'native' && seekSequence !== nativeSeekSequence) setPlayhead(playheadSec(` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:451:mutant:b6f` | ledger 451 | `src/hooks/useTimelinePlayback.ts`: ` if (seekSequence !== nativeSeekSequence) setPlayhead(playheadSec(), tracks) ` → ` if (backend === 'portable-browser' && seekSequence !== nativeSeekSequence) setPlayhead(pl` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:452:mutant:hookwit` | ledger 452 | `src/hooks/useTimelinePlayback.ts`: ` const ensureLivePortableSession = async (): Promise<void> => { ` → ` const ensureLivePortableSession = async (): Promise<void> => { if (mounted) return ` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:453:mutant:hookwit` | ledger 453 | `src/hooks/useTimelinePlayback.ts`: ` void Promise.allSettled([cancellation, playAttempt?.promise, rebuildPromise]).then(async ` → ` void Promise.allSettled([cancellation, playAttempt?.promise, rebuildPromise]).then(() => ` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:454:mutant:hookwit` | ledger 454 | `src/hooks/useTimelinePlayback.ts`: ` // Stop leaves the browser's paused session live at the start, as seekPrepared(0) does fo` → `` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:455:mutant:hookwit` | ledger 455 | `src/hooks/useTimelinePlayback.ts`: ` // A kept paused session follows a paused locate, so a warm start and its schedule begin ` → `` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:457:mutant:hookwit` | ledger 457 | `src/hooks/useTimelinePlayback.ts`: ` if (result !== "started") return ensureLivePortableSession() if (token === nativeLifecycl` → ` if (result === "started" && token === nativeLifecycleToken && !nativePlayback.isActive())` | its test command (30 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:460:mutant:b6f` | ledger 460 | `src/hooks/useTimelinePlayback.ts`: ` const owned = () => mounted && portableBrowserOptions !== undefined` → ` const owned = () => portableBrowserOptions !== undefined` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:461:mutant:b6f` | ledger 461 | `src/hooks/useTimelinePlayback.ts`: ` && !untrack(isPlaying) && playAttempt === undefined && !rebuildInProgress ` → ` && playAttempt === undefined && !rebuildInProgress ` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:462:mutant:b6f` | ledger 462 | `src/hooks/useTimelinePlayback.ts`: ` // A pending ensurePrepared answers a newer locate with the older position: seek again. i` → `` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:463:mutant:b6f` | ledger 463 | `src/hooks/useTimelinePlayback.ts`: ` await pendingBackendPause?.promise.catch(() => undefined) ` → ` if (pendingBackendPause !== undefined) return ` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:464:mutant:b6f` | ledger 464 | `src/hooks/useTimelinePlayback.ts`: `).then(ensureLivePortableSession).catch(() => undefined) setActiveBackend('idle')` → `).catch(() => undefined) setActiveBackend('idle')` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:465:mutant:b6f2` | ledger 465 | `src/hooks/useTimelinePlayback.ts`: ` // Without a native preview, the portable session is the paused graph this hook keeps liv` → ` // Without a native preview, the portable session is the paused graph this hook keeps liv` | its test command (5 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:465:mutant:b6f` | ledger 465 | `src/hooks/useTimelinePlayback.ts`: ` // Without a native preview, the portable session is the paused graph this hook keeps liv` → ` // Without a native preview, the portable session is the paused graph this hook keeps liv` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:466:mutant:b6f2` | ledger 466 | `src/hooks/useTimelinePlayback.ts`: ` if (result !== "started") return ensureLivePortableSession() if (token === nativeLifecycl` → ` if (result === "started" && token === nativeLifecycleToken && !nativePlayback.isActive())` | its test command (5 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:467:mutant:b6f3` | ledger 467 | `src/hooks/useTimelinePlayback.ts`: `).then(ensureLivePortableSession).catch(() => undefined) setActiveBackend('idle')` → `).catch(() => undefined) setActiveBackend('idle')` | its test command (1 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:467:mutant:b6f` | ledger 467 | `src/hooks/useTimelinePlayback.ts`: `).then(ensureLivePortableSession).catch(() => undefined) setActiveBackend('idle')` → `).catch(() => undefined) setActiveBackend('idle')` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:468:mutant:b6f3` | ledger 468 | `src/hooks/useTimelinePlayback.ts`: ` // ensurePrepared keeps a paused session that stands at the playhead, so an edit replaces` → `` | its test command (1 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:468:mutant:b6f2` | ledger 468 | `src/hooks/useTimelinePlayback.ts`: ` // ensurePrepared keeps a paused session that stands at the playhead, so an edit replaces` → `` | its test command (5 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:468:mutant:b6f` | ledger 468 | `src/hooks/useTimelinePlayback.ts`: ` // ensurePrepared keeps a paused session that stands at the playhead, so an edit replaces` → `` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:470:mutant:b6f3` | ledger 470 | `src/hooks/useTimelinePlayback.ts`: ` // The paused session now carries this fingerprint, so a re-run without an edit keeps it.` → `` | its test command (1 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:470:mutant:b6f2` | ledger 470 | `src/hooks/useTimelinePlayback.ts`: ` // The paused session now carries this fingerprint, so a re-run without an edit keeps it.` → `` | its test command (5 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:470:mutant:b6f` | ledger 470 | `src/hooks/useTimelinePlayback.ts`: ` // The paused session now carries this fingerprint, so a re-run without an edit keeps it.` → `` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:471:mutant:b6f3` | ledger 471 | `src/hooks/useTimelinePlayback.ts`: `} else if (projectionChanged && playAttempt === undefined ` → `} else if (playAttempt === undefined ` | its test command (1 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:471:mutant:b6f2` | ledger 471 | `src/hooks/useTimelinePlayback.ts`: `} else if (projectionChanged && playAttempt === undefined ` → `} else if (playAttempt === undefined ` | its test command (5 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:471:mutant:b6f` | ledger 471 | `src/hooks/useTimelinePlayback.ts`: `} else if (projectionChanged && playAttempt === undefined ` → `} else if (playAttempt === undefined ` | its test command (8 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:484:mutant:portable` | ledger 484 | `src/lib/portable-browser-playback-controller.ts`: ` if (!active && pendingStart) await pendingStart.catch(() => undefined) ` → `` | its test command (53 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:495:mutant:matrix` | ledger 495 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, groupId, volume, soloed, sends, outputTargetId, clips` | its test command (238 pass) still passes; row disposition "recorded SURVIVES (pre-witness) -> now semantic kill by exactly the witness the ledger names; accepted disposition (re-witnessed as 500) holds" |
| `ledger:496:mutant:matrix` | ledger 496 | `src/hooks/useTimelinePlayback.ts`: ` // The resolved mixer graph is compiled from the tracks and fx above (compileLivePlayback` → `` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:497:mutant:matrix` | ledger 497 | `src/hooks/useTimelinePlayback.ts`: ` portableCompiledFingerprint = untrack(() => readDesiredScheduleFingerprint())` → ` if (!context?.liveAdoption) portableCompiledFingerprint = untrack(() => readDesiredSchedu` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:500:mutant:matrix` | ledger 500 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, groupId, volume, soloed, sends, outputTargetId, clips` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:501:mutant:matrix` | ledger 501 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, groupId, volume, muted, sends, outputTargetId, clips ` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:505:mutant:matrix` | ledger 505 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, outputTargetId, clips` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:506:mutant:matrix` | ledger 506 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, clips }) => ({` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:507:mutant:matrix` | ledger 507 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, groupId, volume, muted, soloed, sends, outputTargetId, clips }) =>` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `ledger:508:mutant:matrix` | ledger 508 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId` → `tracks.map(({ id, kind, channelRole, volume, muted, soloed, sends, outputTargetId, clips }` | its test command (238 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `c0:m513-mutant-proj` | c0 513 | `src/hooks/useTimelinePlayback.ts`: ` return { id, historyRef, mediaStatus, startSec,` → ` return { waveformAssetKey: clip.waveformAssetKey, id, historyRef, mediaStatus, startSec,` | its test command (7 pass) still passes; the row is killed by another arm; this arm's witness does not reach the mutated code |
| `rc2:385:1:mutant` | rc2 385 | `tools/acceptance/ae-08-processor-state-fuzz-host.ts`: asset lookup ignores the capacity limit | the fuzz seed passes; row 385 stays killed by `385:0` and `385:2`. Retired by the MISMATCH ruling (surviving arm) |
| `rc2:390:1:mutant` | rc2 390 | `src/lib/desktop/native-playback-controller.ts`: drops `ingestProjectedProcessors(refreshed.snapshot)` | the fuzz seed passes; row 390 stays killed by `390:0`. Retired by the MISMATCH ruling (surviving arm) |
| `rc2:418:0:mutant` | rc2 418 | `src/hooks/useTimelinePlayback.ts`: `pendingStart.promise` → `undefined` | its test command exits 0, no test fails. Row 418 retired as "no witness" by the MISMATCH ruling |
| `rc2:418:1:mutant` | rc2 418 | `src/hooks/useTimelinePlayback.ts`: `pendingStart.promise` → `undefined` | fails exactly the two tests its control fails; no arm discriminates. Retired as "no witness" |
| `rc2:419:0:mutant` | rc2 419 | `src/hooks/useTimelinePlayback.ts`: drops `&& !rebuildInProgress` | fails exactly the two tests its control fails; no arm discriminates. Retired as "no witness" |
| `ledger:486:mutant:{b6f5,matrix,playback}` | ledger 486 | `src/hooks/useTimelinePlayback.ts`: `if (outcome === "rebuild") {` → `if (!portableBrowserPlayback.isRecording()) {` | the mutated branch was deleted by cd259c14 with the `rebuild` adopt result; recorded as survivors in rebase 29 (AE-08 phase 8 step 10) |
| `ledger:481:mutant:matrix` | ledger 481 | `src/hooks/useTimelinePlayback.ts`: `rebuildStartingPlay \|\| pendingPlay?.token === playAttemptToken` → `rebuildStartingPlay` | the probe matrix counts rebuilds and no cell reaches a rebuild that lands on a pending Play; the b6f5 and playback arms kill it with `B6f5 481 …` (rebase 30, AE-08 phase 8 step 10b) |
| `ledger:492:mutant:matrix`, `ledger:493:mutant:matrix` | ledger 492, 493 | `src/hooks/useTimelinePlayback.ts`: `tracks.map(({ id, kind, ...` → adds `name` to the fingerprint | the probe matrix counts rebuilds and a name in the fingerprint no longer causes one; the playback and step5b arms of both rows still kill it (AE-08 phase 8 step 10, rebase 29) |

## Retired controls

- `rc2:385:1:control`
- `rc2:390:1:control`
- `rc2:418:0:control`
- `rc2:418:1:control`
- `rc2:419:0:control`
- `rc2:265:0:control`
- `rc2:266:0:control`
- `rc2:267:0:control`
- `rc2:279:0:control`
- `rc2:279:2:control`
- `rc2:388:1:control`
- `rc2:389:1:control`
- `rc2:392:1:control`
- `rc2:393:1:control`
- `rc2:398:0:control`
- `rc2:398:1:control`
- `rc2:398:2:control`
- `rc2:399:1:control`
- `rc2:400:0:control`
- `rc2:400:1:control`
- `rc2:400:2:control`
- `rc2:408:0:control`
- `rc2:420:0:control`
- `rc2:422:0:control`
- `rc2:422:1:control`
- `rc2:428:0:control`
- `rc2:429:0:control`
- `rc2:429:2:control`
- `rc2:429:3:control`
- `rc2:433:0:control`
- `rc2:437:1:control`
- `ledger:439:control:hookwit`
- `ledger:440:control:hookwit`
- `ledger:441:control:p1-audiosync`
- `ledger:442:control:p1-audiosync`
- `ledger:443:control:p1-controller`
- `ledger:444:control:p1-audiosync`
- `ledger:450:control:hookwit`
- `ledger:451:control:b6f`
- `ledger:452:control:hookwit`
- `ledger:453:control:hookwit`
- `ledger:454:control:hookwit`
- `ledger:455:control:hookwit`
- `ledger:457:control:hookwit`
- `ledger:460:control:b6f`
- `ledger:461:control:b6f`
- `ledger:462:control:b6f`
- `ledger:463:control:b6f`
- `ledger:464:control:b6f`
- `ledger:465:control:b6f2`
- `ledger:465:control:b6f`
- `ledger:466:control:b6f2`
- `ledger:467:control:b6f3`
- `ledger:467:control:b6f`
- `ledger:468:control:b6f3`
- `ledger:468:control:b6f2`
- `ledger:468:control:b6f`
- `ledger:470:control:b6f3`
- `ledger:470:control:b6f2`
- `ledger:470:control:b6f`
- `ledger:471:control:b6f3`
- `ledger:471:control:b6f2`
- `ledger:471:control:b6f`
- `ledger:484:control:portable`
- `ledger:495:control:matrix`
- `ledger:496:control:matrix`
- `ledger:497:control:matrix`
- `ledger:500:control:matrix`
- `ledger:501:control:matrix`
- `ledger:505:control:matrix`
- `ledger:506:control:matrix`
- `ledger:507:control:matrix`
- `ledger:508:control:matrix`
- `c0:m513-control-proj`
