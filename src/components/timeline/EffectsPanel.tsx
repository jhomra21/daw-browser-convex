import {
  type Component,
  Show,
  For,
  createEffect,
  createSignal,
} from "solid-js";
import type { AudioEffectKind } from "@daw-browser/shared";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Delay from "~/components/effects/Delay";
import Compressor from "~/components/effects/Compressor";
import Eq from "~/components/effects/Eq";
import Reverb from "~/components/effects/Reverb";
import Saturator from "~/components/effects/Saturator";
import Synth from "~/components/effects/Synth";
import SynthCard from "~/components/effects/SynthCard";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { BOTTOM_PANEL_EDGE_PADDING_PX } from "~/lib/bottom-panel-layout";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import {
  createEffectsPanelController,
  type EffectsPanelAudioEffects,
  type EffectsPanelInstrumentDevice,
} from "~/components/timeline/create-effects-panel-controller";
import {
  createEffectCardReorderDrag,
  type EffectCardReorderPreview,
} from "~/components/timeline/create-effect-card-reorder-drag";

type EffectsPanelProps = {
  isOpen: boolean;
  showOpenButton: boolean;
  shell: TimelineBottomPanelShellControls;
  selectedFXTarget: Track["id"] | "master";
  tracks: Track[];
  onClose: () => void;
  onOpen: () => void;
  clipTab: {
    canOpen: boolean;
    onOpen: () => void;
  };
  audioEngine: AudioEngine;
  projectId?: string;
  userId?: string;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
  grantClipWrite?: OptimisticGrantWrite;
  // Timeline context
  isPlaying: boolean;
  playheadSec?: number;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onLocalSaveFailed?: (message: string) => void;
  onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void;
  onEffectChainElementChange?: (element: HTMLElement | undefined) => void;
};

const EffectsPanelClosedFooter: Component<{
  onOpen: () => void;
  clipTab: EffectsPanelProps["clipTab"];
}> = (props) => (
  <div
    class="fixed left-0 right-0 bottom-0 z-50 bg-neutral-900"
    style={{ "padding-bottom": `${BOTTOM_PANEL_EDGE_PADDING_PX}px` }}
  >
    <TimelineBottomPanelFooter
      activeTab="effects"
      toggleLabel="Show"
      onEffectsTabClick={props.onOpen}
      onClipTabClick={props.clipTab.canOpen ? props.clipTab.onOpen : undefined}
      onToggle={props.onOpen}
    />
  </div>
);

type EffectsPanelInstrumentSectionProps = {
  instrument: {
    state: EffectsPanelInstrumentDevice;
    canWrite: boolean;
  };
};

const EffectsPanelInstrumentSection: Component<EffectsPanelInstrumentSectionProps> = (props) => (
  <div
    class="flex h-full shrink-0 items-stretch gap-3"
    classList={{ "pointer-events-none opacity-60": !props.instrument.canWrite }}
  >
    <Show when={props.instrument.state.arp.params()}>
      {(params) => (
        <Arpeggiator
          params={params()}
          onChange={(updates) => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.arp.change(updates);
          }}
          onToggleEnabled={(enabled) => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.arp.toggle(enabled);
          }}
          onReset={() => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.arp.reset();
          }}
          disabled={!props.instrument.canWrite}
        />
      )}
    </Show>

    <Show
      when={
        props.instrument.state.synth.isExpandedForCurrentTarget()
          ? undefined
          : props.instrument.state.synth.params()
      }
    >
      {(params) => (
        <Synth
          params={params()}
          onChange={(updates) => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.synth.change(updates);
          }}
          onReset={() => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.synth.reset();
          }}
          onExpand={() => {
            if (!props.instrument.canWrite) return;
            props.instrument.state.synth.open();
          }}
          disabled={!props.instrument.canWrite}
          variant="compact"
        />
      )}
    </Show>

    <Show
      when={
        !!props.instrument.state.synth.params() &&
        props.instrument.state.synth.isExpandedForCurrentTarget()
      }
    >
      <div class="flex min-w-48 items-center justify-between border border-neutral-800 bg-neutral-900 px-2 py-2 text-neutral-300">
        <span class="text-xs">Synth is expanded</span>
        <button
          class="border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
          onClick={props.instrument.state.synth.close}
        >
          Restore
        </button>
      </div>
    </Show>
  </div>
);

type EffectsPanelEffectCardsProps = {
  audioEffects: EffectsPanelAudioEffects;
  canWrite: boolean;
  onElementChange?: (element: HTMLElement) => void;
  spectrum: SpectrumFrame | null;
};

type EffectsPanelAudioEffectCardProps = {
  effect: AudioEffectKind;
  audioEffects: EffectsPanelAudioEffects;
  spectrum: SpectrumFrame | null;
};

const EffectsPanelAudioEffectCard: Component<EffectsPanelAudioEffectCardProps> = (props) => {
  if (props.effect === "eq") {
    return (
      <Show when={props.audioEffects.eq.params()}>
        {(params) => <Eq bands={params().bands} enabled={params().enabled} channelMode={params().channelMode} onBandChange={props.audioEffects.eq.changeBand} onChannelModeChange={props.audioEffects.eq.changeChannelMode} onBandToggle={props.audioEffects.eq.toggleBand} onToggleEnabled={props.audioEffects.eq.toggleEnabled} onReset={props.audioEffects.eq.reset} spectrumData={props.spectrum} />}
      </Show>
    );
  }
  if (props.effect === "saturator") {
    return (
      <Show when={props.audioEffects.saturator.params()}>
        {(params) => <Saturator params={params()} onChange={props.audioEffects.saturator.change} onToggleEnabled={props.audioEffects.saturator.toggleEnabled} onReset={props.audioEffects.saturator.reset} />}
      </Show>
    );
  }
  if (props.effect === "compressor") {
    return (
      <Show when={props.audioEffects.compressor.params()}>
        {(params) => <Compressor params={params()} onChange={props.audioEffects.compressor.change} onToggleEnabled={props.audioEffects.compressor.toggleEnabled} onReset={props.audioEffects.compressor.reset} />}
      </Show>
    );
  }
  if (props.effect === "delay") {
    return (
      <Show when={props.audioEffects.delay.params()}>
        {(params) => <Delay params={params()} onChange={props.audioEffects.delay.change} onToggleEnabled={props.audioEffects.delay.toggleEnabled} onReset={props.audioEffects.delay.reset} />}
      </Show>
    );
  }
  return (
    <Show when={props.audioEffects.reverb.params()}>
      {(params) => <Reverb params={params()} onChange={props.audioEffects.reverb.change} onToggleEnabled={props.audioEffects.reverb.toggleEnabled} onReset={props.audioEffects.reverb.reset} />}
    </Show>
  );
};

const EffectsPanelEffectCards: Component<EffectsPanelEffectCardsProps> = (props) => {
  const [reorderPreview, setReorderPreview] = createSignal<EffectCardReorderPreview>();

  return (
    <>
      <div
        class="flex h-full min-w-16 shrink-0 items-stretch gap-3"
        classList={{ "pointer-events-none opacity-60": !props.canWrite }}
        ref={(element) => props.onElementChange?.(element)}
      >
        <For each={props.audioEffects.orderedEffects()}>
          {(effect) => {
            const drag = createEffectCardReorderDrag({
              effect,
              orderedEffects: props.audioEffects.orderedEffects,
              canWrite: () => props.canWrite,
              onReorder: props.audioEffects.reorder,
              onPreviewChange: setReorderPreview,
            });
            return (
              <div
                data-effect-kind={effect}
                class="touch-none transition-opacity"
                classList={{ "opacity-30": reorderPreview()?.effect === effect }}
                onPointerDown={drag.onPointerDown}
              >
                <EffectsPanelAudioEffectCard effect={effect} audioEffects={props.audioEffects} spectrum={props.spectrum} />
              </div>
            );
          }}
        </For>
      </div>

      <Show when={reorderPreview()}>
        {(preview) => (
          <>
            <div
              class="pointer-events-none fixed z-50 w-px bg-cyan-300 shadow-lg"
              style={{
                left: `${preview().indicatorX}px`,
                top: `${preview().top}px`,
                height: `${preview().height}px`,
                transform: "translateX(-50%)",
              }}
            />
            <div
              class="pointer-events-none fixed z-50 opacity-60 shadow-2xl"
              style={{
                left: `${preview().ghost.left}px`,
                top: `${preview().ghost.top}px`,
                width: `${preview().ghost.width}px`,
                height: `${preview().ghost.height}px`,
              }}
            >
              <EffectsPanelAudioEffectCard effect={preview().effect} audioEffects={props.audioEffects} spectrum={props.spectrum} />
            </div>
          </>
        )}
      </Show>
    </>
  );
};

const EffectsPanelReadOnlyNotice: Component = () => (
  <div class="flex min-w-60 items-center border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-xs text-neutral-500">
    Effects are read-only for collaborator-owned tracks.
  </div>
);

type EffectsPanelEmptyStateProps = {
  empty: {
    visible: boolean;
    currentTargetId: string;
  };
};

const EffectsPanelEmptyState: Component<EffectsPanelEmptyStateProps> = (props) => (
  <Show when={props.empty.visible}>
    <div class="flex items-center px-4 text-sm text-neutral-400">
      No devices on this {props.empty.currentTargetId === "master" ? "master bus" : "track"}.
      Add instruments or effects from the Browser.
    </div>
  </Show>
);

type EffectsPanelFloatingSynthProps = {
  synth: EffectsPanelInstrumentDevice["synth"];
  canWrite: boolean;
};

const EffectsPanelFloatingSynth: Component<EffectsPanelFloatingSynthProps> = (props) => {
  const card = () => props.synth.expandedCard();

  return (
    <Show when={props.canWrite ? card() : undefined}>
      {(expandedCard) => (
        <SynthCard
          params={expandedCard().params}
          onChange={expandedCard().onChange}
          onReset={expandedCard().onReset}
          x={expandedCard().x}
          y={expandedCard().y}
          w={expandedCard().w}
          h={expandedCard().h}
          onChangeBounds={props.synth.updateCardBounds}
          onClose={props.synth.close}
        />
      )}
    </Show>
  );
};

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const controller = createEffectsPanelController({
    isOpen: () => props.isOpen,
    selectedFXTarget: () => props.selectedFXTarget,
    tracks: () => props.tracks,
    audioEngine: () => props.audioEngine,
    projectId: () => props.projectId,
    userId: () => props.userId,
    isPlaying: () => props.isPlaying,
    playheadSec: () => props.playheadSec,
    canWriteTrackRouting: props.canWriteTrackRouting,
    grantClipWrite: props.grantClipWrite,
    onClose: props.onClose,
    onSelectClip: props.onSelectClip,
    insertLocalClip: props.insertLocalClip,
    onEffectParamsCommitted: props.onEffectParamsCommitted,
    onLocalSaveFailed: props.onLocalSaveFailed,
    onDeviceInsertActionsChange: props.onDeviceInsertActionsChange,
  });
  const { target, devices, spectrum, canWriteCurrentTargetEffects, isCurrentTargetReadOnly } = controller;
  const { instrument, audioEffects } = devices;
  const eqForTarget = audioEffects.eq.params;
  const compressorForTarget = audioEffects.compressor.params;
  const saturatorForTarget = audioEffects.saturator.params;
  const delayForTarget = audioEffects.delay.params;
  const reverbForTarget = audioEffects.reverb.params;

  createEffect(() => {
    if (props.isOpen) return;
    props.onEffectChainElementChange?.(undefined);
  });

  return (
    <>
      <Show when={props.isOpen}>
        <TimelineBottomPanelShell
          controls={props.shell}
          resizeLabel="Resize effects panel"
          footer={
            <TimelineBottomPanelFooter
              activeTab="effects"
              toggleLabel="Hide"
              onEffectsTabClick={props.onOpen}
              onClipTabClick={props.clipTab.canOpen ? props.clipTab.onOpen : undefined}
              onToggle={controller.close}
            />
          }
        >
          <div class="flex h-full min-h-0 flex-col">
            <div class="flex flex-1 flex-col overflow-hidden min-h-0">
              <div
                class="flex-1 overflow-x-auto overflow-y-hidden px-1 py-[3px] min-h-0"
              >
                <div class="flex items-stretch gap-3 h-full min-w-min min-h-0">
                  <Show when={target.isInstrumentTrack()}>
                    <EffectsPanelInstrumentSection
                      instrument={{
                        state: instrument,
                        canWrite: canWriteCurrentTargetEffects(),
                      }}
                    />
                  </Show>
                  <EffectsPanelEffectCards
                    audioEffects={audioEffects}
                    canWrite={canWriteCurrentTargetEffects()}
                    onElementChange={props.onEffectChainElementChange}
                    spectrum={spectrum()}
                  />
                  <Show when={isCurrentTargetReadOnly()}>
                    <EffectsPanelReadOnlyNotice />
                  </Show>
                  <EffectsPanelEmptyState
                    empty={{
                      visible:
                        !eqForTarget() &&
                        !compressorForTarget() &&
                        !saturatorForTarget() &&
                        !delayForTarget() &&
                        !reverbForTarget() &&
                        !instrument.arp.params() &&
                        (!instrument.synth.params() ||
                          !target.isInstrumentTrack()),
                      currentTargetId: target.currentTargetId(),
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </TimelineBottomPanelShell>
      </Show>

      <Show when={!props.isOpen && props.showOpenButton}>
        <EffectsPanelClosedFooter onOpen={props.onOpen} clipTab={props.clipTab} />
      </Show>

      <EffectsPanelFloatingSynth synth={instrument.synth} canWrite={canWriteCurrentTargetEffects()} />
    </>
  );
};

export default EffectsPanel;
