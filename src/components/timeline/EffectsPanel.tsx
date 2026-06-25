import {
  type Component,
  Show,
  For,
} from "solid-js";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Eq from "~/components/effects/Eq";
import Reverb from "~/components/effects/Reverb";
import Synth from "~/components/effects/Synth";
import SynthCard from "~/components/effects/SynthCard";
import {
  createEffectsPanelState,
} from "~/components/timeline/create-effects-panel-state";
import {
  type EqChannelMode,
  type EqParams,
  type ReverbParams,
} from "@daw-browser/shared";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import { BOTTOM_PANEL_EDGE_PADDING_PX } from "~/lib/bottom-panel-layout";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import type { EffectKind } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { createEffectsPanelController } from "~/components/timeline/create-effects-panel-controller";

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
};

type InstrumentPanelState = ReturnType<typeof createEffectsPanelState>;

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
    state: InstrumentPanelState;
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
  effects: {
    orderedEffects: EffectKind[];
    eqParams?: EqParams;
    reverbParams?: ReverbParams;
    canWrite: boolean;
    spectrum: SpectrumFrame | null;
    onBandChange: (bandId: string, updates: Partial<EqParams["bands"][number]>) => void;
    onChannelModeChange: (mode: EqChannelMode) => void;
    onBandToggle: (bandId: string) => void;
    onToggleEqEnabled: (enabled: boolean) => void;
    onResetEq: () => void;
    onReverbChange: (updates: Partial<ReverbParams>) => void;
    onReverbToggle: (enabled: boolean) => void;
    onResetReverb: () => void;
  };
};

const EffectsPanelEffectCards: Component<EffectsPanelEffectCardsProps> = (props) => (
  <div
    class="flex h-full shrink-0 items-stretch gap-3"
    classList={{ "pointer-events-none opacity-60": !props.effects.canWrite }}
  >
    <For each={props.effects.orderedEffects}>
      {(effect) => (
        <Show
          when={effect === "eq"}
          fallback={
            <Show when={props.effects.reverbParams}>
              {(params) => (
                <Reverb
                  params={params()}
                  onChange={props.effects.onReverbChange}
                  onToggleEnabled={props.effects.onReverbToggle}
                  onReset={props.effects.onResetReverb}
                />
              )}
            </Show>
          }
        >
          <Show when={props.effects.eqParams}>
            {(params) => (
              <Eq
                bands={params().bands}
                enabled={params().enabled}
                channelMode={params().channelMode}
                onBandChange={props.effects.onBandChange}
                onChannelModeChange={props.effects.onChannelModeChange}
                onBandToggle={props.effects.onBandToggle}
                onToggleEnabled={props.effects.onToggleEqEnabled}
                onReset={props.effects.onResetEq}
                spectrumData={props.effects.spectrum}
              />
            )}
          </Show>
        </Show>
      )}
    </For>
  </div>
);

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
  synth: InstrumentPanelState["synth"];
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
  const { target, instrument, audioEffects, spectrum, canWriteCurrentTargetEffects, isCurrentTargetReadOnly } = controller;
  const eqForTarget = audioEffects.eq.params;
  const reverbForTarget = audioEffects.reverb.params;

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
              <div class="flex-1 overflow-x-auto overflow-y-hidden px-1 py-[3px] min-h-0">
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
                    effects={{
                      orderedEffects: audioEffects.orderedEffects(),
                      eqParams: eqForTarget(),
                      reverbParams: reverbForTarget(),
                      canWrite: canWriteCurrentTargetEffects(),
                      spectrum: spectrum(),
                      onBandChange: audioEffects.eq.changeBand,
                      onChannelModeChange: audioEffects.eq.changeChannelMode,
                      onBandToggle: audioEffects.eq.toggleBand,
                      onToggleEqEnabled: audioEffects.eq.toggleEnabled,
                      onResetEq: audioEffects.eq.reset,
                      onReverbChange: audioEffects.reverb.change,
                      onReverbToggle: audioEffects.reverb.toggleEnabled,
                      onResetReverb: audioEffects.reverb.reset,
                    }}
                  />
                  <Show when={isCurrentTargetReadOnly()}>
                    <EffectsPanelReadOnlyNotice />
                  </Show>
                  <EffectsPanelEmptyState
                    empty={{
                      visible:
                        !eqForTarget() &&
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
