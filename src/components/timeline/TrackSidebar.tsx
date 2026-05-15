import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  canTrackReceiveAudioClip,
  getTrackChannelRole,
} from "~/lib/track-routing";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import { cn } from "~/lib/utils";
import type { Track, TrackSend } from "~/types/timeline";

type TrackSidebarProps = {
  sidebar: {
    tracks: Track[];
    selectedTrackId: Track["id"] | "";
    sidebarWidth: number;
    onTrackClick: (trackId: Track["id"]) => void;
    onAddTrack: () => void;
    onAddReturnTrack?: () => void;
    onAddGroupTrack?: () => void;
    onAddInstrumentTrack?: () => void;
    canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
    onTrackSendsChange?: (trackId: Track["id"], sends: TrackSend[]) => void;
    onTrackOutputTargetChange?: (
      trackId: Track["id"],
      outputTargetId?: Track["id"],
    ) => void;
    onVolumeChange: (trackId: Track["id"], volume: number) => void;
    onSidebarMouseDown: (e: MouseEvent) => void;
    onToggleMute: (trackId: Track["id"]) => void;
    onToggleSolo: (trackId: Track["id"]) => void;
    syncMix: boolean;
    onToggleSyncMix: () => void;
    recordArmTrackId: Track["id"] | null;
    onToggleRecordArm: (trackId: Track["id"]) => void;
    currentUserId?: string;
    isPlaying: boolean;
    getTrackLevel: (trackId: Track["id"]) => number;
    getTrackLevels?: (trackId: Track["id"]) => [number, number];
    bottomOffsetPx?: number;
  };
};

const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  const sidebar = () => props.sidebar;

  const [meters, setMeters] = createSignal<
    Record<string, { L: number; R: number }>
  >({});
  let rafId: number | null = null;
  let lastTs: number | null = null;
  const releasePerSec = 3.0;

  // Event-driven meter updates are not exposed by the audio engine yet, so keep this
  // RAF loop local to the sidebar and tear it down deterministically on cleanup.
  const scheduleTick = () => {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  };

  const tick = () => {
    rafId = null;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = lastTs == null ? 0 : Math.max(0, (now - lastTs) / 1000);
    lastTs = now;
    const prev = meters();
    const next: Record<string, { L: number; R: number }> = {};
    const playing = !!sidebar().isPlaying;

    try {
      for (const track of sidebar().tracks) {
        let srcL = 0;
        let srcR = 0;
        if (playing) {
          const stereo = sidebar().getTrackLevels?.(track.id);
          if (stereo) {
            srcL = stereo[0] ?? 0;
            srcR = stereo[1] ?? 0;
          } else {
            const mono = sidebar().getTrackLevel(track.id);
            srcL = mono;
            srcR = mono;
          }
        }
        const previous = prev[track.id] || { L: 0, R: 0 };
        const decay = releasePerSec * dt;
        const left =
          srcL >= previous.L ? srcL : Math.max(srcL, previous.L - decay);
        const right =
          srcR >= previous.R ? srcR : Math.max(srcR, previous.R - decay);
        next[track.id] = {
          L: clampUnit(left),
          R: clampUnit(right),
        };
      }
    } catch {}

    const metersChanged =
      sidebar().tracks.some((track) => {
        const previous = prev[track.id];
        const current = next[track.id];
        return (
          !previous ||
          !current ||
          previous.L !== current.L ||
          previous.R !== current.R
        );
      }) || Object.keys(prev).length !== sidebar().tracks.length;
    if (metersChanged) setMeters(next);
    if (playing) scheduleTick();
  };

  createEffect(() => {
    if (sidebar().isPlaying) {
      scheduleTick();
      return;
    }
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    setMeters((current) => (Object.keys(current).length === 0 ? current : {}));
    lastTs = null;
  });

  onCleanup(() => {
    if (rafId != null) cancelAnimationFrame(rafId);
  });

  const groupTracks = createMemo(() =>
    sidebar().tracks.filter((track) => getTrackChannelRole(track) === "group"),
  );
  const returnTracks = createMemo(() =>
    sidebar().tracks.filter((track) => getTrackChannelRole(track) === "return"),
  );
  const returnTrackNames = createMemo(
    () =>
      new Map(
        returnTracks().map((track, index) => [track.id, `Return ${index + 1}`]),
      ),
  );
  const displayTrackName = (track: Track) =>
    returnTrackNames().get(track.id) ?? track.name;

  const canWriteTrackRouting = (track: Track) =>
    sidebar().canWriteTrackRouting?.(track.id) ?? true;

  const handleOutputTargetChange = (track: Track, value: string) => {
    if (!canWriteTrackRouting(track)) return;
    const outputTargetId = value
      ? groupTracks().find((groupTrack) => groupTrack.id === value)?.id
      : undefined;
    sidebar().onTrackOutputTargetChange?.(track.id, outputTargetId);
  };

  const selectedSendTargetId = (track: Track) =>
    track.sends?.find((send) => send.amount > 0.0001)?.targetId ?? "";

  const handleSendTargetChange = (track: Track, targetId: string) => {
    if (!canWriteTrackRouting(track)) return;
    const returnTrack = returnTracks().find(
      (candidate) => candidate.id === targetId,
    );
    const currentTargetId = selectedSendTargetId(track);
    const existingSends = track.sends ?? [];
    if (!returnTrack) {
      sidebar().onTrackSendsChange?.(
        track.id,
        existingSends.filter((send) => send.targetId !== currentTargetId),
      );
      return;
    }
    const amount =
      existingSends.find((send) => send.targetId === returnTrack.id)?.amount ??
      1;
    sidebar().onTrackSendsChange?.(track.id, [
      ...existingSends.filter(
        (send) =>
          send.targetId !== currentTargetId && send.targetId !== returnTrack.id,
      ),
      { targetId: returnTrack.id, amount },
    ]);
  };

  let activeVolumePointerId: number | null = null;
  let activeVolumeTrackId: Track["id"] | null = null;
  let activeVolumeValue: number | null = null;

  const clampUnit = (value: number) => Math.max(0, Math.min(1, value));
  const clampVolume = (volume: number) => clampUnit(volume);
  const quantizeVolume = (volume: number) =>
    Math.round(clampVolume(volume) * 100) / 100;

  const volumeFromPointer = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    return quantizeVolume((clientX - rect.left) / width);
  };

  const updateTrackVolume = (track: Track, volume: number) => {
    const nextVolume = quantizeVolume(volume);
    if (activeVolumeTrackId === track.id) {
      if (activeVolumeValue === nextVolume) return;
      activeVolumeValue = nextVolume;
    } else if (nextVolume === quantizeVolume(track.volume ?? 0.8)) {
      return;
    }
    sidebar().onVolumeChange(track.id, nextVolume);
  };

  const updateVolumeFromPointer = (
    track: Track,
    input: HTMLInputElement,
    clientX: number,
  ) => {
    updateTrackVolume(track, volumeFromPointer(input, clientX));
  };

  return (
    <>
      <div
        class="relative z-20 -mx-[7px] flex w-4 cursor-col-resize justify-center"
        onMouseDown={sidebar().onSidebarMouseDown}
      >
        <div class="pointer-events-none h-full w-0.5 bg-neutral-700" />
      </div>

      <div
        class="track-sidebar-scroll overflow-y-auto overflow-x-hidden border-l border-neutral-800 bg-neutral-900 p-0"
        style={{
          width: `${sidebar().sidebarWidth}px`,
          "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
          "padding-bottom": `${sidebar().bottomOffsetPx ?? 0}px`,
        }}
      >
        <div class="flex items-center justify-between gap-2 p-1">
          <button
            class={cn(
              "rounded-md p-0.5 text-xs font-medium transition-transform ease-out active:scale-97",
              sidebar().syncMix
                ? "bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/30"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-300",
            )}
            onClick={sidebar().onToggleSyncMix}
            title="Toggle syncing mute/solo across users"
          >
            Sync Mix
          </button>
          <div class="flex min-w-0 items-center gap-2 pr-2">
            <button
              class="cursor-pointer whitespace-nowrap text-base text-neutral-400 transition-transform ease-out active:scale-97 hover:text-neutral-300"
              onClick={sidebar().onAddTrack}
            >
              Add Track
            </button>
            <button
              class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700"
              onClick={() => sidebar().onAddReturnTrack?.()}
              title="Add return track"
            >
              + Return
            </button>
            <button
              class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700"
              onClick={() => sidebar().onAddGroupTrack?.()}
              title="Add group bus"
            >
              + Group
            </button>
            <button
              class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700"
              onClick={() => sidebar().onAddInstrumentTrack?.()}
              title="Add instrument track (for MIDI clips)"
            >
              + Inst
            </button>
          </div>
        </div>
        <For each={sidebar().tracks}>
          {(track) => {
            const lockedByOther =
              !!track.lockedBy && track.lockedBy !== sidebar().currentUserId;
            const isRecordArmed = sidebar().recordArmTrackId === track.id;
            const channelRole = getTrackChannelRole(track);
            const isReturnTrack = channelRole === "return";
            const isGroupTrack = channelRole === "group";
            const muteDisabled = lockedByOther;
            const soloDisabled = lockedByOther;
            const volumeDisabled = lockedByOther;
            const recordDisabled =
              lockedByOther || !canTrackReceiveAudioClip(track);
            const volume = () => track.volume ?? 0.8;
            const muted = () => !!track.muted;
            const soloed = () => !!track.soloed;
            const currentSendTargetId = () => selectedSendTargetId(track);

            return (
              <div
                class={cn(
                  sidebar().selectedTrackId === track.id
                    ? "bg-neutral-800"
                    : "border-t border-neutral-800 bg-neutral-900",
                )}
                style={{ height: "96px" }}
                onClick={() => sidebar().onTrackClick(track.id)}
              >
                <div class="grid h-full grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 p-2">
                  <div class="min-w-0 overflow-hidden">
                    <button
                      class={cn(
                        "flex h-7 w-full items-center justify-center rounded-sm border px-2 text-center text-sm font-semibold",
                        muteDisabled
                          ? "cursor-not-allowed border-neutral-700 text-neutral-500"
                          : muted()
                            ? "border-neutral-700 bg-amber-500 text-black"
                            : sidebar().selectedTrackId === track.id
                              ? "border-neutral-700"
                              : "border-neutral-700 hover:border-neutral-600",
                      )}
                      style={{ "border-width": "0.5px" }}
                      disabled={muteDisabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (muteDisabled) return;
                        sidebar().onToggleMute(track.id);
                      }}
                      title={
                        lockedByOther
                          ? "Track locked by another user"
                          : muted()
                            ? "Unmute track"
                            : "Mute track"
                      }
                    >
                      <span class="flex min-w-0 flex-col items-center gap-1">
                        <span class="truncate">{displayTrackName(track)}</span>
                        <Show when={isGroupTrack}>
                          <span class="rounded bg-neutral-700 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-300">
                            Group
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>

                  <div class="flex min-w-0 flex-col gap-1">
                    <Show when={!isGroupTrack}>
                      <select
                        value={track.outputTargetId ?? ""}
                        disabled={!canWriteTrackRouting(track)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          handleOutputTargetChange(
                            track,
                            event.currentTarget.value,
                          )
                        }
                        class="h-7 w-full rounded border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200 outline-none focus:border-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-500"
                        title="Track output"
                      >
                        <option value="">Master</option>
                        <For each={groupTracks()}>
                          {(groupTrack) => (
                            <option value={groupTrack.id}>
                              {groupTrack.name}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>

                    <Show when={channelRole === "track"}>
                      <select
                        value={currentSendTargetId()}
                        disabled={
                          !canWriteTrackRouting(track) ||
                          returnTracks().length === 0
                        }
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          handleSendTargetChange(
                            track,
                            event.currentTarget.value,
                          )
                        }
                        class="h-7 w-full rounded border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200 outline-none focus:border-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-500"
                        title="Track send"
                      >
                        <option value="">None</option>
                        <For each={returnTracks()}>
                          {(returnTrack) => (
                            <option value={returnTrack.id}>
                              {displayTrackName(returnTrack)}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                  </div>

                  <div class="flex w-[92px] items-center gap-2">
                    <div class="flex w-[72px] shrink-0 flex-col gap-1">
                      <div class="grid grid-cols-2 gap-1">
                        <button
                          class={cn(
                            "flex h-7 items-center justify-center rounded border text-xs font-bold transition-colors",
                            recordDisabled
                              ? "cursor-not-allowed border-red-900 bg-neutral-800 text-red-900"
                              : isRecordArmed
                                ? "border-red-400 bg-red-500 text-black shadow-inner"
                                : "border-red-500 text-red-400 hover:bg-red-500/20",
                          )}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : isReturnTrack
                                ? "Return tracks cannot be armed for recording"
                                : isGroupTrack
                                  ? "Group tracks cannot be armed for recording"
                                  : track.kind === "instrument"
                                    ? "Instrument tracks cannot be armed for audio recording"
                                    : isRecordArmed
                                      ? "Disarm recording"
                                      : "Arm for recording"
                          }
                          disabled={recordDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (recordDisabled) return;
                            sidebar().onToggleRecordArm(track.id);
                          }}
                        >
                          R
                        </button>

                        <button
                          class={cn(
                            "h-7 rounded border px-2 text-xs font-semibold",
                            soloDisabled
                              ? "cursor-not-allowed border-neutral-700 bg-neutral-700/40 text-neutral-500"
                              : soloed()
                                ? "border-blue-300 bg-blue-500/90 text-black"
                                : "border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
                          )}
                          disabled={soloDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (soloDisabled) return;
                            sidebar().onToggleSolo(track.id);
                          }}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : soloed()
                                ? "Unsolo"
                                : "Solo"
                          }
                        >
                          S
                        </button>
                      </div>

                      <div class="flex h-7 items-center px-0.5">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={volume()}
                          disabled={volumeDisabled}
                          style={{
                            "--track-volume-percent": `${volume() * 100}%`,
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            if (volumeDisabled) return;
                            event.preventDefault();
                            activeVolumePointerId = event.pointerId;
                            activeVolumeTrackId = track.id;
                            activeVolumeValue = quantizeVolume(
                              track.volume ?? 0.8,
                            );
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            updateVolumeFromPointer(
                              track,
                              event.currentTarget,
                              event.clientX,
                            );
                          }}
                          onPointerMove={(event) => {
                            if (activeVolumePointerId !== event.pointerId)
                              return;
                            event.stopPropagation();
                            updateVolumeFromPointer(
                              track,
                              event.currentTarget,
                              event.clientX,
                            );
                          }}
                          onPointerUp={(event) => {
                            if (activeVolumePointerId !== event.pointerId)
                              return;
                            event.stopPropagation();
                            activeVolumePointerId = null;
                            activeVolumeTrackId = null;
                            activeVolumeValue = null;
                            if (
                              event.currentTarget.hasPointerCapture(
                                event.pointerId,
                              )
                            ) {
                              event.currentTarget.releasePointerCapture(
                                event.pointerId,
                              );
                            }
                          }}
                          onPointerCancel={(event) => {
                            if (activeVolumePointerId !== event.pointerId)
                              return;
                            activeVolumePointerId = null;
                            activeVolumeTrackId = null;
                            activeVolumeValue = null;
                          }}
                          onInput={(event) => {
                            event.stopPropagation();
                            if (volumeDisabled) return;
                            updateTrackVolume(
                              track,
                              parseFloat(event.currentTarget.value),
                            );
                          }}
                          class={cn(
                            "track-volume-slider w-full cursor-pointer",
                            volumeDisabled && "cursor-not-allowed opacity-60",
                          )}
                          title={
                            lockedByOther
                              ? "Track locked by another user"
                              : "Track volume"
                          }
                        />
                      </div>
                    </div>

                    <div class="relative h-16 w-[12px] shrink-0">
                      <div class="absolute inset-0 flex items-end justify-center gap-1">
                        {(() => {
                          const meter = sidebar().isPlaying
                            ? meters()[track.id]
                            : undefined;
                          const left = clampUnit(meter?.L ?? 0);
                          const right = clampUnit(meter?.R ?? 0);
                          const leftColor =
                            left >= 0.98 ? "bg-red-500" : "bg-green-500";
                          const rightColor =
                            right >= 0.98 ? "bg-red-500" : "bg-green-500";
                          return (
                            <>
                              <div class="relative h-full w-1 overflow-hidden rounded-full bg-neutral-950/70">
                                <div
                                  class={cn(
                                    "absolute bottom-0 w-full rounded-full transition-all duration-75",
                                    leftColor,
                                  )}
                                  style={{ height: `${left * 100}%` }}
                                />
                              </div>
                              <div class="relative h-full w-1 overflow-hidden rounded-full bg-neutral-950/70">
                                <div
                                  class={cn(
                                    "absolute bottom-0 w-full rounded-full transition-all duration-75",
                                    rightColor,
                                  )}
                                  style={{ height: `${right * 100}%` }}
                                />
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
};

export default TrackSidebar;
