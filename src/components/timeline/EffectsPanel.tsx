import {
  type Component,
  Show,
  Match,
  Switch,
  For,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import { AUDIO_EFFECT_CONTRACTS, automationEnvelopeValueRange, automationTargetKey, isJsonObject, isLocalId, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams, normalizeSpectralParamsEnvelope, normalizeUtilityParamsEnvelope, type AudioEffectInstance, type AudioEffectKind, type AutomationEnvelope, type JsonObject, type SynthParams, type TrackInstrumentParams } from "@daw-browser/shared";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Delay from "~/components/effects/Delay";
import Compressor from "~/components/effects/Compressor";
import Eq from "~/components/effects/Eq";
import Reverb from "~/components/effects/Reverb";
import Saturator from "~/components/effects/Saturator";
import Utility from "~/components/effects/Utility";
import Gate from "~/components/effects/Gate";
import Limiter from "~/components/effects/Limiter";
import LoFi from "~/components/effects/LoFi";
import AutoFilter from "~/components/effects/AutoFilter";
import AutoPan from "~/components/effects/AutoPan";
import Chorus from "~/components/effects/Chorus";
import Ensemble from "~/components/effects/Ensemble";
import Flanger from "~/components/effects/Flanger";
import Phaser from "~/components/effects/Phaser";
import Tremolo from "~/components/effects/Tremolo";
import Spectral from "~/components/effects/Spectral";
import Synth from "~/components/effects/Synth";
import DrumRack from "~/components/effects/DrumRack";
import Sampler from "~/components/effects/Sampler";
import Granular from "~/components/effects/Granular";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import type { Clip, ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { BOTTOM_PANEL_EDGE_PADDING_PX } from "~/lib/bottom-panel-layout";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import type { TimelinePlaybackRebuildIntent } from "~/hooks/useTimelinePlayback";
import {
  createEffectsPanelController,
  type EffectsPanelAudioEffects,
  type EffectsPanelInstrumentDevice,
} from "~/components/timeline/create-effects-panel-controller";
import {
  createEffectCardReorderDrag,
  type EffectCardReorderPreview,
} from "~/components/timeline/create-effect-card-reorder-drag";
import { overlayEffectAutomationValue } from "~/components/timeline/effect-automation-display";
import TimelineContextMenu, {
  type TimelineContextMenuItem,
} from "~/components/timeline/context-menu/timeline-context-menu";
import {
  CONTEXT_MENU_AUDIO_EFFECT_CATALOG,
  CONTEXT_MENU_INSTRUMENT_CATALOG,
  CONTEXT_MENU_MIDI_EFFECT_CATALOG,
  getAudioEffectDeviceCatalogEntry,
} from "~/lib/device-catalog";
import { isEditableKeyboardTarget } from "~/lib/keyboard-event-target";
import { createSynthAutomationState, overlaySynthAutomationValues } from "~/components/timeline/synth-automation";
import {
  deleteLocalExternalProcessor,
  listLocalExternalProcessors,
  mergeLocalExternalProcessorParameterOverride,
  setLocalExternalProcessorBypassed,
} from "~/lib/external-plugins";
import { reorderLocalMixedEffects } from "~/lib/local-effects";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { selectExternalProcessorsForTarget } from "~/lib/external-plugin-ui";
import { ExternalPluginCard, nativeEditorAnchorFromElement } from "~/components/timeline/external-plugin-card";
import type { NativeVstParameterQueue } from "~/lib/desktop/native-vst-parameter-queue";
import type { MixedEffectOrderItem } from "~/lib/mixed-effect-order";
import {
  createEffectsPanelDeviceCollapse,
  DeviceCollapseProvider,
  safeDeviceContentId,
  deviceCollapseIdentity,
  type DeviceCollapseIdentity,
} from "~/components/timeline/create-effects-panel-device-collapse";
import { isDeviceInteractiveTarget } from "~/components/timeline/device-interaction";

type EffectsPanelProps = {
  isOpen: boolean;
  showOpenButton: boolean;
  shell: TimelineBottomPanelShellControls;
  selectedFXTarget: Track["id"] | "master";
  tracks: Track[];
  sidechainRoutes: ExternalSidechainRoute[];
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
  playheadSec?: number;
  onSelectClip?: (trackId: Track["id"], clipId: string, startSec: number) => void;
  insertLocalClip?: (trackId: Track["id"], clip: Clip) => void;
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  onStructuralPlaybackChange?: (targetId: Track["id"], next: TrackInstrumentParams) => void;
  usesLegacyAudioEngine?: () => boolean;
  projectGeneration?: () => number;
  onEffectParamsPreview?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void;
  onEffectParamsFlush?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void | Promise<void>;
  onPreviewNote?: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void;
  onEffectInstanceParamsReplayChange?: Parameters<typeof createEffectsPanelController>[0]["onEffectInstanceParamsReplayChange"];
  onLocalSaveFailed?: (message: string) => void;
  onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void;
  onExportSnapshotChange?: Parameters<typeof createEffectsPanelController>[0]["onExportSnapshotChange"];
  onEffectChainElementChange?: (element: HTMLElement | undefined) => void;
  automationEnvelopes?: AutomationEnvelope[];
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (targetKey: Track["id"] | "master", parameterId: string, effectInstanceId?: string) => void;
  onManualAutomationOverride?: (targetKey: Track["id"] | "master", parameterId: string, effectInstanceId?: string) => void;
  autoOpenExternalProcessorId?: string;
  onExternalProcessorAutoOpenHandled?: (instanceId: string) => void;
  onExternalProcessorUpdated?: (
    processor: ExternalProcessor,
    previous: ExternalProcessor,
    intent?: TimelinePlaybackRebuildIntent,
  ) => void;
  captureStructuralPlaybackIntent?: () => TimelinePlaybackRebuildIntent;
  onMixedReorderCommitted?: (intent?: TimelinePlaybackRebuildIntent) => void;
  enqueueNativeVstParameter?: NativeVstParameterQueue["enqueue"];
  spectrumProvider?: (targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>;
};

const EffectsPanelClosedFooter: Component<{
  onOpen: () => void;
  clipTab: EffectsPanelProps["clipTab"];
}> = (props) => (
  <TimelineContextMenu
    items={() => [
      { kind: "label", label: "Effects Panel" },
      { kind: "item", label: "Show effects panel", onSelect: props.onOpen },
    ]}
  >
    <div
      class="fixed left-0 right-0 bottom-0 z-50 bg-app-surface"
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
  </TimelineContextMenu>
);

type EffectsPanelInstrumentSectionProps = {
  instrument: {
    state: EffectsPanelInstrumentDevice;
    canWrite: boolean;
  };
  audioEngine: AudioEngine;
  targetId: string;
  projectId?: string;
  onPreviewNote?: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void;
  synthAutomationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>;
  synthAutomationParameterIds?: ReadonlyMap<string, string>;
  synthAutomationDisplayParams?: SynthParams;
  onSelectSynthAutomationParameter?: (parameterId: string) => void;
  onManualSynthAutomationOverride?: (parameterId: string) => void;
  deviceCollapse: ReturnType<typeof createEffectsPanelDeviceCollapse>;
};

const EffectsPanelDeviceBoundary: Component<{
  identity: DeviceCollapseIdentity;
  canWrite: boolean;
  collapse: ReturnType<typeof createEffectsPanelDeviceCollapse>;
  menuItems: () => TimelineContextMenuItem[];
  children: JSX.Element;
}> = (props) => {
  const identity = () => props.identity;
  const collapsed = () => props.collapse.isCollapsed(identity());
  return (
    <DeviceCollapseProvider
      collapsed={collapsed}
      toggle={() => props.collapse.toggle(identity())}
      contentId={() => safeDeviceContentId(identity())}
      canWrite={() => props.canWrite}
    >
      <TimelineContextMenu
        items={() => [
          ...props.menuItems(),
          { kind: "separator" },
          {
            kind: "item",
            label: collapsed() ? "Unfold device" : "Fold device",
            onSelect: () => props.collapse.toggle(identity()),
          },
        ]}
      >
        {props.children}
      </TimelineContextMenu>
    </DeviceCollapseProvider>
  );
};

const EffectsPanelInstrumentSection: Component<EffectsPanelInstrumentSectionProps> = (props) => (
  <div
    class="flex h-full shrink-0 items-stretch gap-3"
  >
    <Show when={props.instrument.state.arp.params()}>
      {(params) => (
        <EffectsPanelDeviceBoundary
          identity={deviceCollapseIdentity.arp(props.targetId)}
          canWrite={props.instrument.canWrite}
          collapse={props.deviceCollapse}
          menuItems={() => [
            { kind: "label", label: "Arpeggiator" },
            {
              kind: "item",
              label: params().enabled ? "Disable device" : "Enable device",
              disabled: !props.instrument.canWrite,
              onSelect: () => props.instrument.state.arp.toggle(!params().enabled),
            },
            {
              kind: "item",
              label: "Reset device",
              disabled: !props.instrument.canWrite,
              onSelect: props.instrument.state.arp.reset,
            },
          ]}
        >
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
        </EffectsPanelDeviceBoundary>
      )}
    </Show>

    <Show when={props.instrument.state.drumRack.params()}>
      {(params) => (
        <EffectsPanelDeviceBoundary
          identity={deviceCollapseIdentity.instrument(props.instrument.state.activeInstrument()?.instanceId ?? "drum-rack")}
          canWrite={props.instrument.canWrite}
          collapse={props.deviceCollapse}
          menuItems={() => [
            { kind: "label", label: "Drum Rack" },
            { kind: "item", label: "Reset device", disabled: !props.instrument.canWrite, onSelect: props.instrument.state.drumRack.reset },
          ]}
        >
          <DrumRack
            params={params()}
            targetId={props.targetId}
            projectId={props.projectId}
            audioEngine={props.audioEngine}
            onPreviewNote={props.onPreviewNote}
            canWrite={props.instrument.canWrite}
            onAssignSampleToPad={props.instrument.state.drumRack.assignSampleToPad}
            buffers={() => props.instrument.state.drumRack.buffers(props.targetId, params())}
            subscribeBuffers={props.instrument.state.drumRack.subscribeBuffers}
            onReset={props.instrument.state.drumRack.reset}
            onUpdatePad={props.instrument.state.drumRack.updatePad}
          />
        </EffectsPanelDeviceBoundary>
      )}
    </Show>
    <Show when={props.instrument.state.sampler.params()}>
      {(params) => (
        <EffectsPanelDeviceBoundary
          identity={deviceCollapseIdentity.instrument(props.instrument.state.activeInstrument()?.instanceId ?? "sampler")}
          canWrite={props.instrument.canWrite}
          collapse={props.deviceCollapse}
          menuItems={() => [
            { kind: "label", label: "Sampler" },
            { kind: "item", label: "Reset device", disabled: !props.instrument.canWrite, onSelect: props.instrument.state.sampler.reset },
          ]}
        >
          <Sampler
            params={params()}
            status={props.instrument.state.sampler.status()}
            canWrite={props.instrument.canWrite}
            onAddZone={props.instrument.state.sampler.addZone}
            onRemoveZone={props.instrument.state.sampler.removeZone}
            onReset={props.instrument.state.sampler.reset}
            onRetryZone={props.instrument.state.sampler.retryZone}
            onUpdate={props.instrument.state.sampler.update}
            onUpdateZone={props.instrument.state.sampler.updateZone}
          />
        </EffectsPanelDeviceBoundary>
      )}
    </Show>
    <Show when={props.instrument.state.granular.params()}>
      {(params) => (
        <EffectsPanelDeviceBoundary
          identity={deviceCollapseIdentity.instrument(props.instrument.state.activeInstrument()?.instanceId ?? "granular")}
          canWrite={props.instrument.canWrite}
          collapse={props.deviceCollapse}
          menuItems={() => [
            { kind: "label", label: "Granular" },
            { kind: "item", label: "Reset device", disabled: !props.instrument.canWrite, onSelect: props.instrument.state.granular.reset },
          ]}
        >
          <Granular
            params={params()}
            status={props.instrument.state.granular.status()}
            canWrite={props.instrument.canWrite}
            onReset={props.instrument.state.granular.reset}
            onRetry={props.instrument.state.granular.retry}
            onUpdate={props.instrument.state.granular.update}
          />
        </EffectsPanelDeviceBoundary>
      )}
    </Show>

    <Show when={props.instrument.state.synth.params()}>
      {(params) => (
        <EffectsPanelDeviceBoundary
          identity={deviceCollapseIdentity.instrument(props.instrument.state.synth.instanceId() ?? "synth")}
          canWrite={props.instrument.canWrite}
          collapse={props.deviceCollapse}
          menuItems={() => [
            { kind: "label", label: "Synth" },
            { kind: "item", label: "Reset device", disabled: !props.instrument.canWrite, onSelect: props.instrument.state.synth.reset },
          ]}
        >
          <Synth
            instanceId={props.instrument.state.synth.instanceId()}
            params={props.synthAutomationDisplayParams ?? params()}
            onChange={(updates) => {
              if (!props.instrument.canWrite) return;
              props.instrument.state.synth.change(updates);
            }}
            onReset={() => {
              if (!props.instrument.canWrite) return;
              props.instrument.state.synth.reset();
            }}
            disabled={!props.instrument.canWrite}
            automationRangesByParameterId={props.synthAutomationRangesByParameterId}
            onAutomationParameterTouch={(parameterId) => {
              const automationParameterId = props.synthAutomationParameterIds?.get(parameterId)
              if (automationParameterId) props.onSelectSynthAutomationParameter?.(automationParameterId)
            }}
            onManualAutomationOverride={(parameterId) => {
              const automationParameterId = props.synthAutomationParameterIds?.get(parameterId)
              if (automationParameterId) props.onManualSynthAutomationOverride?.(automationParameterId)
            }}
          />
        </EffectsPanelDeviceBoundary>
      )}
    </Show>
  </div>
);

type EffectsPanelEffectCardsProps = {
  projectId?: string;
  audioEffects: EffectsPanelAudioEffects;
  externalProcessors: ExternalProcessor[];
  externalInstrument?: ExternalProcessor;
  enqueueParameter: NativeVstParameterQueue["enqueue"];
  canWrite: boolean;
  onElementChange?: (element: HTMLElement | undefined) => void;
  spectrum: SpectrumFrame | null;
  audioEngine: AudioEngine;
  targetId: Track["id"] | "master";
  tracks: Track[];
  sidechainRoutes: ExternalSidechainRoute[];
  automationRangesByInstanceId?: ReadonlyMap<string, ReadonlyMap<string, { min: number; max: number }>>;
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (parameterId: string, effectInstanceId: string) => void;
  onManualAutomationOverride?: (parameterId: string, effectInstanceId: string) => void;
  autoOpenExternalProcessorId?: string;
  onExternalProcessorAutoOpenHandled?: (instanceId: string) => void;
  onRemoveExternalProcessor: (instanceId: string) => void;
  onExternalParameterChange: (instanceId: string, parameterId: number, value: number) => void;
  onExternalBypassChange: (instanceId: string, bypassed: boolean) => void;
  onMixedReorder: (order: readonly MixedEffectOrderItem[]) => void;
  deviceCollapse: ReturnType<typeof createEffectsPanelDeviceCollapse>;
};

type EffectsPanelAudioEffectCardProps = {
  effect: AudioEffectInstance;
  audioEffects: EffectsPanelAudioEffects;
  spectrum: SpectrumFrame | null;
  audioEngine?: AudioEngine;
  targetId?: Track["id"] | "master";
  tracks?: Track[];
  sidechainRoutes?: ExternalSidechainRoute[];
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>;
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (parameterId: string) => void;
  onManualAutomationOverride?: (parameterId: string) => void;
};

const audioEffectLabel = (kind: AudioEffectKind) => getAudioEffectDeviceCatalogEntry(kind).label;
type EffectParamsInput = ReturnType<EffectsPanelAudioEffects["paramsForInstance"]>;
const effectParamsInput = (params: EffectParamsInput | JsonObject): JsonObject => (
  isJsonObject(params) ? params : {}
);

const createAudioEffectContextMenuItems = (input: {
  label: string;
  canWrite: boolean;
  enabled: () => boolean;
  toggleEnabled: (enabled: boolean) => void;
  reset: () => void;
  remove?: () => void;
}): TimelineContextMenuItem[] => [
  { kind: "label", label: input.label },
  {
    kind: "item",
    label: input.enabled() ? "Disable device" : "Enable device",
    disabled: !input.canWrite,
    onSelect: () => input.toggleEnabled(!input.enabled()),
  },
  {
    kind: "item",
    label: "Reset device",
    disabled: !input.canWrite,
    onSelect: input.reset,
  },
  {
    kind: "item",
    label: "Delete device",
    disabled: !input.canWrite || !input.remove,
    onSelect: input.remove,
  },
];

const createAudioEffectContextMenuControls = (
  effect: AudioEffectInstance,
  audioEffects: EffectsPanelAudioEffects,
  targetId?: Track["id"] | "master",
) => {
  const remove = targetId
    ? () => {
      void audioEffects.removeByInstanceFromTarget(targetId, effect).catch(() => undefined);
    }
    : undefined;
  if (effect.kind === "eq") {
    return {
      label: audioEffectLabel("eq"),
      enabled: () => normalizeEqParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.eq.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.eq.changeInstance(effect.id, () => normalizeEqParams({})),
      remove,
    };
  }
  if (effect.kind === "utility") {
    return {
      label: audioEffectLabel("utility"),
      enabled: () => normalizeUtilityParamsEnvelope(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.utility.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.utility.changeInstance(effect.id, () => normalizeUtilityParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "gate") {
    return {
      label: audioEffectLabel("gate"),
      enabled: () => normalizeGateParamsEnvelope(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.gate.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.gate.changeInstance(effect.id, () => normalizeGateParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "compressor") {
    return {
      label: audioEffectLabel("compressor"),
      enabled: () => normalizeCompressorParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.compressor.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.compressor.changeInstance(effect.id, () => normalizeCompressorParams({})),
      remove,
    };
  }
  if (effect.kind === "limiter") {
    return {
      label: audioEffectLabel("limiter"),
      enabled: () => normalizeLimiterParamsEnvelope(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.limiter.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.limiter.changeInstance(effect.id, () => normalizeLimiterParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "saturator") {
    return {
      label: audioEffectLabel("saturator"),
      enabled: () => normalizeSaturatorParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.saturator.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.saturator.changeInstance(effect.id, () => normalizeSaturatorParams({})),
      remove,
    };
  }
  if (effect.kind === "delay") {
    return {
      label: audioEffectLabel("delay"),
      enabled: () => normalizeDelayParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.delay.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.delay.changeInstance(effect.id, () => normalizeDelayParams({})),
      remove,
    };
  }
  if (effect.kind === "autofilter") return { label: audioEffectLabel("autofilter"), enabled: () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.autofilter.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.autofilter.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({})), remove };
  if (effect.kind === "chorus") return { label: audioEffectLabel("chorus"), enabled: () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.chorus.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.chorus.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({})), remove };
  if (effect.kind === "flanger") return { label: audioEffectLabel("flanger"), enabled: () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.flanger.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.flanger.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({})), remove };
  if (effect.kind === "phaser") return { label: audioEffectLabel("phaser"), enabled: () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.phaser.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.phaser.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({})), remove };
  if (effect.kind === "tremolo") return { label: audioEffectLabel("tremolo"), enabled: () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.tremolo.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.tremolo.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({})), remove };
  if (effect.kind === "autopan") return { label: audioEffectLabel("autopan"), enabled: () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.autopan.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.autopan.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({})), remove };
  if (effect.kind === "ensemble") return { label: audioEffectLabel("ensemble"), enabled: () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.ensemble.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.ensemble.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({})), remove };
  if (effect.kind === "lofi") return { label: audioEffectLabel("lofi"), enabled: () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.lofi.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.lofi.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({})), remove };
  if (effect.kind === "spectral") return { label: audioEffectLabel("spectral"), enabled: () => normalizeSpectralParamsEnvelope(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.spectral.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.spectral.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams()), remove };
  return {
    label: audioEffectLabel("reverb"),
    enabled: () => normalizeReverbParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
    toggleEnabled: (enabled: boolean) => audioEffects.reverb.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
    reset: () => audioEffects.reverb.changeInstance(effect.id, () => normalizeReverbParams({})),
    remove,
  };
};

const EffectsPanelAudioEffectCard: Component<EffectsPanelAudioEffectCardProps> = (props) => {
  const params = () => props.audioEffects.paramsForInstance(props.effect);
  const displayedParams = () => {
    let next = effectParamsInput(params());
    const targetId = props.targetId;
    if (!targetId) return next;
    const ranges = props.automationRangesByParameterId;
    const values = props.evaluatedValuesByTargetKey;
    if (!ranges || !values) return next;
    for (const parameterId of ranges.keys()) {
      const targetKey = automationTargetKey(
        targetId === "master"
          ? { kind: "master", effectInstanceId: props.effect.id }
          : { kind: "track", trackId: targetId, effectInstanceId: props.effect.id },
        parameterId,
      );
      const evaluatedValue = values.get(targetKey);
      if (evaluatedValue !== undefined) {
        next = overlayEffectAutomationValue(next, parameterId, evaluatedValue);
      }
    }
    return next;
  };
  const sidechainSourceTrackId = () => (
    props.sidechainRoutes?.find(
      (route) => route.targetTrackId === props.targetId && route.effectInstanceId === props.effect.id,
    )?.sourceTrackId
  );
  return (
    <Switch>
      <Match when={props.effect.kind === "utility"}>
        <Show when={displayedParams()}>{(value) => <Utility params={normalizeUtilityParamsEnvelope(value()).state} onChange={(updates) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => normalizeUtilityParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.utility.changeInstance(props.effect.id, () => normalizeUtilityParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "gate"}>
        <Show when={displayedParams()}>{(value) => <Gate params={normalizeGateParamsEnvelope(value()).state} tracks={props.tracks ?? []} targetId={props.targetId ?? "master"} effectInstanceId={props.effect.id} audioEngine={props.audioEngine} sourceTrackId={sidechainSourceTrackId()} onSourceChange={(source) => void props.audioEffects.gate.setSidechainSource(props.effect.id, source)} onChange={(updates) => props.audioEffects.gate.changeInstance(props.effect.id, (prev) => normalizeGateParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.gate.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.gate.changeInstance(props.effect.id, () => normalizeGateParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "limiter"}>
        <Show when={displayedParams()}>{(value) => <Limiter params={normalizeLimiterParamsEnvelope(value()).state} targetId={props.targetId ?? "master"} effectInstanceId={props.effect.id} audioEngine={props.audioEngine} onChange={(updates) => props.audioEffects.limiter.changeInstance(props.effect.id, (prev) => normalizeLimiterParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.limiter.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.limiter.changeInstance(props.effect.id, () => normalizeLimiterParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "lofi"}>
        <Show when={displayedParams()}>{(value) => <LoFi params={AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.lofi.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.lofi.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.lofi.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "autofilter"}>
        <Show when={displayedParams()}>{(value) => <AutoFilter params={AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.autofilter.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.autofilter.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.autofilter.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "chorus"}>
        <Show when={displayedParams()}>{(value) => <Chorus params={AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.chorus.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.chorus.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.chorus.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "flanger"}>
        <Show when={displayedParams()}>{(value) => <Flanger params={AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.flanger.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.flanger.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.flanger.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "phaser"}>
        <Show when={displayedParams()}>{(value) => <Phaser params={AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.phaser.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.phaser.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.phaser.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "tremolo"}>
        <Show when={displayedParams()}>{(value) => <Tremolo params={AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.tremolo.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.tremolo.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.tremolo.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "autopan"}>
        <Show when={displayedParams()}>{(value) => <AutoPan params={AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.autopan.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.autopan.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.autopan.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "ensemble"}>
        <Show when={displayedParams()}>{(value) => <Ensemble params={AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.ensemble.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.ensemble.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.ensemble.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>
      </Match>
      <Match when={props.effect.kind === "eq"}>
      <Show when={displayedParams()}>
        {(value) => {
          const eq = () => normalizeEqParams(effectParamsInput(value()));
          return <Eq bands={eq().bands} enabled={eq().enabled} channelMode={eq().channelMode} onBandChange={(bandId, updates) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band) }))} onPreviewBandChange={(bandId, updates) => props.audioEffects.eq.previewInteraction(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band) }))} onBeginInteraction={() => props.audioEffects.eq.beginInteraction(props.effect.id)} onCommitInteraction={() => props.audioEffects.eq.commitInteraction(props.effect.id)} onCancelInteraction={() => props.audioEffects.eq.cancelInteraction(props.effect.id)} onChannelModeChange={(channelMode) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => prev.channelMode === channelMode ? prev : normalizeEqParams({ ...prev, channelMode }))} onBandToggle={(bandId) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band) }))} onToggleEnabled={(enabled) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.eq.changeInstance(props.effect.id, () => normalizeEqParams({}))} spectrumData={props.spectrum} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />
        }}
      </Show>
      </Match>
      <Match when={props.effect.kind === "saturator"}>
      <Show when={displayedParams()}>
        {(value) => <Saturator params={normalizeSaturatorParams(effectParamsInput(value()))} onChange={(updates) => props.audioEffects.saturator.changeInstance(props.effect.id, (prev) => normalizeSaturatorParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.saturator.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.saturator.changeInstance(props.effect.id, () => normalizeSaturatorParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
      </Show>
      </Match>
      <Match when={props.effect.kind === "compressor"}>
      <Show when={displayedParams()}>
        {(value) => <Compressor params={normalizeCompressorParams(effectParamsInput(value()))} audioEngine={props.audioEngine} targetId={props.targetId} effectInstanceId={props.effect.id} onChange={(updates) => props.audioEffects.compressor.changeInstance(props.effect.id, (prev) => normalizeCompressorParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.compressor.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.compressor.changeInstance(props.effect.id, () => normalizeCompressorParams({}))} />}
      </Show>
      </Match>
      <Match when={props.effect.kind === "delay"}>
      <Show when={displayedParams()}>
        {(value) => <Delay params={normalizeDelayParams(effectParamsInput(value()))} onChange={(updates) => props.audioEffects.delay.changeInstance(props.effect.id, (prev) => normalizeDelayParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.delay.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.delay.changeInstance(props.effect.id, () => normalizeDelayParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
      </Show>
      </Match>
      <Match when={props.effect.kind === "spectral"}>
      <Show when={displayedParams()}>
        {(value) => (
          <Spectral
            params={normalizeSpectralParamsEnvelope(value()).state}
            tracks={props.tracks ?? []}
            targetId={props.targetId ?? "master"}
            sourceTrackId={sidechainSourceTrackId()}
            onSourceChange={(source) => void props.audioEffects.spectral.setSidechainSource(props.effect.id, source)}
            onChange={(updates) => props.audioEffects.spectral.changeInstance(props.effect.id, (prev) => normalizeSpectralParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))}
            onToggleEnabled={(enabled) => props.audioEffects.spectral.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))}
            onReset={() => props.audioEffects.spectral.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams())}
            automationRangesByParameterId={props.automationRangesByParameterId}
            onAutomationParameterTouch={props.onSelectAutomationParameter}
            onManualAutomationOverride={props.onManualAutomationOverride}
          />
        )}
      </Show>
      </Match>
      <Match when={true}>
        <Show when={displayedParams()}>
      {(value) => <Reverb params={normalizeReverbParams(effectParamsInput(value()))} onChange={(updates) => props.audioEffects.reverb.changeInstance(props.effect.id, (prev) => normalizeReverbParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.reverb.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.reverb.changeInstance(props.effect.id, () => normalizeReverbParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
        </Show>
      </Match>
    </Switch>
  );
};

const EffectsPanelEffectCards: Component<EffectsPanelEffectCardsProps> = (props) => {
  type MixedCard =
    | { kind: "builtin"; key: string; id: string; effect: AudioEffectInstance }
    | { kind: "external"; key: string; id: string; processor: ExternalProcessor };
  const model = createMemo<{ keys: string[]; byKey: Map<string, MixedCard> }>(() => {
    const builtinEffects = props.audioEffects.orderedEffects();
    const cards = [
      ...builtinEffects.map((effect) => ({
        kind: "builtin" as const,
        key: deviceCollapseIdentity.audioEffect(effect.id),
        id: effect.id,
        effect,
      })),
      ...props.externalProcessors
        .filter((processor) => processor.manifest.role === "effect")
        .map((processor) => ({
          kind: "external" as const,
          key: deviceCollapseIdentity.external(processor.instanceId),
          id: processor.instanceId,
          processor,
        })),
    ];
    const indexForCard = (card: MixedCard) => card.kind === "builtin"
      ? props.audioEffects.effectIndexForTarget(props.targetId, card.id)
      : card.processor.index;
    const ordered = cards
      .map((card) => ({ card, index: indexForCard(card) ?? Number.MAX_SAFE_INTEGER }))
      .sort((left, right) => left.index - right.index || left.card.key.localeCompare(right.card.key))
      .map(({ card }) => card);
    return {
      keys: ordered.map((card) => card.key),
      byKey: new Map(ordered.map((card) => [card.key, card])),
    };
  });
  const [reorderPreview, setReorderPreview] = createSignal<EffectCardReorderPreview>();
  const [selection, setSelection] = createSignal<{ targetId: string; effectId: string }>();
  let effectCardsElement: HTMLDivElement | undefined;
  const contextMenuItems = (effect: AudioEffectInstance): TimelineContextMenuItem[] => {
    return createAudioEffectContextMenuItems({
      ...createAudioEffectContextMenuControls(effect, props.audioEffects, props.targetId),
      canWrite: props.canWrite,
    });
  };
  const externalProcessorContextMenuItems = (processor: ExternalProcessor): TimelineContextMenuItem[] => [
    { kind: "label", label: processor.manifest.identity.name },
    {
      kind: "item",
      label: processor.bypassed ? "Enable device" : "Disable device",
      disabled: !props.canWrite,
      onSelect: () => props.onExternalBypassChange(processor.instanceId, !processor.bypassed),
    },
    {
      kind: "item",
      label: "Delete device",
      disabled: !props.canWrite,
      onSelect: () => props.onRemoveExternalProcessor(processor.instanceId),
    },
  ];
  const selectedEffect = createMemo(() => {
    const current = selection();
    if (!current || current.targetId !== props.targetId) return;
    return props.audioEffects.orderedEffects().find((effect) => effect.id === current.effectId);
  });
  createEffect(() => {
    if (selection() && !selectedEffect()) setSelection();
  });
  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!effectCardsElement?.contains(event.target instanceof Node ? event.target : null)) {
        setSelection();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    onCleanup(() => window.removeEventListener("pointerdown", handlePointerDown, { capture: true }));
  });
  onCleanup(() => props.onElementChange?.(undefined));
  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      (event.key !== "Delete" && event.key !== "Backspace")
      || isEditableKeyboardTarget(event.target)
      || isDeviceInteractiveTarget(event.target)
    ) return;
    const effect = selectedEffect();
    if (!effect || !props.canWrite) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection();
    void props.audioEffects.removeByInstanceFromTarget(props.targetId, effect).catch(() => undefined);
  };
  const reorderMixedCards = (key: string, targetIndex: number) => {
    const current = model();
    const next = current.keys.filter((entry) => entry !== key);
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, key);
    props.onMixedReorder(next.flatMap((entry) => {
      const card = current.byKey.get(entry);
      return card ? [{ kind: card.kind, instanceId: card.id }] : [];
    }));
  };
  const previewBuiltinEffect = () => {
    const card = model().byKey.get(reorderPreview()?.key ?? "");
    return card?.kind === "builtin" ? card.effect : undefined;
  };

  return (
    <>
      <Show when={props.externalInstrument}>
        {(processor) => {
          let element: HTMLDivElement | undefined;
          return (
            <EffectsPanelDeviceBoundary
              identity={deviceCollapseIdentity.external(processor().instanceId)}
              canWrite={props.canWrite}
              collapse={props.deviceCollapse}
              menuItems={() => externalProcessorContextMenuItems(processor())}
            >
              <div
                data-external-instrument-id={processor().instanceId}
                class="shrink-0"
                ref={(node) => { element = node; }}
              >
                <ExternalPluginCard
                  projectId={props.projectId}
                  processor={processor()}
                  enqueueParameter={props.enqueueParameter}
                  editorAnchor={() => element ? nativeEditorAnchorFromElement(element) : undefined}
                  targetId={props.targetId}
                  automationRanges={props.automationRangesByInstanceId?.get(processor().instanceId)}
                  evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
                  onSelectAutomationParameter={props.onSelectAutomationParameter}
                  onManualAutomationOverride={props.onManualAutomationOverride}
                  autoOpen={props.autoOpenExternalProcessorId === processor().instanceId}
                  onAutoOpenHandled={props.onExternalProcessorAutoOpenHandled}
                  canWrite={props.canWrite}
                  onRemove={() => props.onRemoveExternalProcessor(processor().instanceId)}
                  onBypassChange={(bypassed) => props.onExternalBypassChange(processor().instanceId, bypassed)}
                  onParameterChange={(parameterId, value) => props.onExternalParameterChange(processor().instanceId, parameterId, value)}
                />
              </div>
            </EffectsPanelDeviceBoundary>
          );
        }}
      </Show>
      <div
        class="flex h-full min-w-16 shrink-0 items-stretch gap-3"
        classList={{ "opacity-60": !props.canWrite }}
        data-timeline-keyboard-local="true"
        onKeyDown={handleKeyDown}
        ref={(element) => {
          effectCardsElement = element;
          props.onElementChange?.(element);
        }}
      >
        <For each={model().keys}>
          {(key) => {
            const card = createMemo(() => model().byKey.get(key));
            const externalProcessor = createMemo(() => {
              const value = card();
              return value?.kind === "external" ? value.processor : undefined;
            });
            const builtinEffect = createMemo(() => {
              const value = card();
              return value?.kind === "builtin" ? value.effect : undefined;
            });
            let element: HTMLDivElement | undefined;
            const drag = createEffectCardReorderDrag({
              key,
              orderedKeys: () => model().keys,
              canWrite: () => props.canWrite,
              onReorder: reorderMixedCards,
              onPreviewChange: setReorderPreview,
            });
            return (
              <Show when={card()}>
                {(current) => (
                  <Switch>
                    <Match when={current().kind === "external"}>
                      <Show when={externalProcessor()}>
                        {(processor) => (
                          <div
                            data-external-effect-id={processor().instanceId}
                            data-reorder-key={key}
                            class="touch-none transition-opacity"
                            ref={(node) => { element = node; }}
                            onPointerDown={(event) => {
                              if (!isDeviceInteractiveTarget(event.target)) element?.focus({ preventScroll: true });
                              drag.onPointerDown(event);
                            }}
                            tabIndex={-1}
                          >
                            <EffectsPanelDeviceBoundary
                              identity={deviceCollapseIdentity.external(processor().instanceId)}
                              canWrite={props.canWrite}
                              collapse={props.deviceCollapse}
                              menuItems={() => externalProcessorContextMenuItems(processor())}
                            >
                              <ExternalPluginCard
                                projectId={props.projectId}
                                processor={processor()}
                                enqueueParameter={props.enqueueParameter}
                                editorAnchor={() => element ? nativeEditorAnchorFromElement(element) : undefined}
                                targetId={props.targetId}
                                automationRanges={props.automationRangesByInstanceId?.get(processor().instanceId)}
                                evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
                                onSelectAutomationParameter={props.onSelectAutomationParameter}
                                onManualAutomationOverride={props.onManualAutomationOverride}
                                autoOpen={props.autoOpenExternalProcessorId === processor().instanceId}
                                onAutoOpenHandled={props.onExternalProcessorAutoOpenHandled}
                                canWrite={props.canWrite}
                                onRemove={() => props.onRemoveExternalProcessor(processor().instanceId)}
                                onBypassChange={(bypassed) => props.onExternalBypassChange(processor().instanceId, bypassed)}
                                onParameterChange={(parameterId, value) => props.onExternalParameterChange(processor().instanceId, parameterId, value)}
                              />
                            </EffectsPanelDeviceBoundary>
                          </div>
                        )}
                      </Show>
                    </Match>
                    <Match when={current().kind === "builtin"}>
                      <Show when={builtinEffect()}>
                        {(effect) => (
                          <div
                            data-effect-kind={effect().kind}
                            data-reorder-key={key}
                            class="touch-none transition-opacity focus:outline-none"
                            classList={{
                              "opacity-30": reorderPreview()?.key === key,
                              "[&_.effect-shell]:bg-timeline-surface-muted": selectedEffect()?.id === effect().id,
                            }}
                            ref={(node) => { element = node; }}
                            tabIndex={-1}
                            onPointerDown={(event) => {
                              setSelection({ targetId: props.targetId, effectId: effect().id });
                              if (!isDeviceInteractiveTarget(event.target)) element?.focus({ preventScroll: true });
                              drag.onPointerDown(event);
                            }}
                          >
                            <EffectsPanelDeviceBoundary
                              identity={deviceCollapseIdentity.audioEffect(effect().id)}
                              canWrite={props.canWrite}
                              collapse={props.deviceCollapse}
                              menuItems={() => contextMenuItems(effect())}
                            >
                              <EffectsPanelAudioEffectCard
                                effect={effect()}
                                audioEffects={props.audioEffects}
                                spectrum={props.spectrum}
                                audioEngine={props.audioEngine}
                                targetId={props.targetId}
                                tracks={props.tracks}
                                sidechainRoutes={props.sidechainRoutes}
                                automationRangesByParameterId={props.automationRangesByInstanceId?.get(effect().id)}
                                evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
                                onSelectAutomationParameter={(parameterId) => props.onSelectAutomationParameter?.(parameterId, effect().id)}
                                onManualAutomationOverride={(parameterId) => props.onManualAutomationOverride?.(parameterId, effect().id)}
                              />
                            </EffectsPanelDeviceBoundary>
                          </div>
                        )}
                      </Show>
                    </Match>
                  </Switch>
                )}
              </Show>
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
              <Show when={previewBuiltinEffect()}>
                {(effect) => (
                  <EffectsPanelDeviceBoundary
                    identity={deviceCollapseIdentity.audioEffect(effect().id)}
                    canWrite={props.canWrite}
                    collapse={props.deviceCollapse}
                    menuItems={() => contextMenuItems(effect())}
                  >
                    <EffectsPanelAudioEffectCard effect={effect()} audioEffects={props.audioEffects} spectrum={props.spectrum} />
                  </EffectsPanelDeviceBoundary>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </>
  );
};

const EffectsPanelReadOnlyNotice: Component = () => (
  <div class="flex min-w-60 items-center border border-border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
    Effects are read-only for collaborator-owned tracks.
  </div>
);

const createEffectsPanelContextMenuItems = (input: {
  targetId: Track["id"] | "master";
  targetTrackId?: Track["id"];
  canWrite: boolean;
  audioEffects: EffectsPanelAudioEffects;
  instrument: EffectsPanelInstrumentDevice;
  onHide: () => void;
}): TimelineContextMenuItem[] => {
  const addAudioEffectItems: TimelineContextMenuItem[] = CONTEXT_MENU_AUDIO_EFFECT_CATALOG.map((entry) => ({
    kind: "item",
    label: `Add ${entry.label}`,
    disabled: !input.canWrite || !input.audioEffects.canAddByKindToTarget(input.targetId, entry.kind),
    onSelect: () => {
      void input.audioEffects.addByKindToTarget(input.targetId, entry.kind).catch(() => undefined);
    },
  }));
  const addMidiEffectItems = (targetId: Track["id"]): TimelineContextMenuItem[] => (
    CONTEXT_MENU_MIDI_EFFECT_CATALOG.map((entry) => ({
      kind: "item",
      label: `Add ${entry.label}`,
      disabled: !input.canWrite || Boolean(input.instrument.arp.params()),
      onSelect: () => {
        void input.instrument.arp.addToTarget(targetId);
      },
    }))
  );
  const resetCurrentDevices = () => {
    for (const effect of input.audioEffects.orderedEffects()) {
      createAudioEffectContextMenuControls(effect, input.audioEffects).reset();
    }
    if (input.instrument.arp.params()) input.instrument.arp.reset();
    if (input.instrument.synth.params()) input.instrument.synth.reset();
    if (input.instrument.drumRack.params()) input.instrument.drumRack.reset();
    if (input.instrument.sampler.params()) input.instrument.sampler.reset();
    if (input.instrument.granular.params()) input.instrument.granular.reset();
  };
  const hasCurrentDevices = () => (
    input.audioEffects.orderedEffects().length > 0
    || Boolean(input.instrument.arp.params())
    || Boolean(input.instrument.synth.params())
    || Boolean(input.instrument.drumRack.params())
    || Boolean(input.instrument.sampler.params())
    || Boolean(input.instrument.granular.params())
  );
  const hasAudioEffects = () => input.audioEffects.orderedEffects().length > 0;

  const items: TimelineContextMenuItem[] = [
    { kind: "label", label: input.targetId === "master" ? "Master Effects" : "Track Effects" },
    ...addAudioEffectItems,
  ];

  const targetTrackId = input.targetTrackId;
  if (targetTrackId) {
    items.push(
      { kind: "separator" },
      ...CONTEXT_MENU_INSTRUMENT_CATALOG.map((entry): TimelineContextMenuItem => ({
        kind: "item",
        label: `Use ${entry.label}`,
        disabled: !input.canWrite || input.instrument.readInstrumentForTarget(targetTrackId)?.kind === entry.kind,
        onSelect: () => {
          input.instrument.switchInstrumentForTarget(targetTrackId, entry.kind);
        },
      })),
      ...addMidiEffectItems(targetTrackId),
    );
  }

  items.push(
    { kind: "separator" },
    {
      kind: "item",
      label: input.targetId === "master" ? "Reset master effects" : "Reset track effects",
      disabled: !input.canWrite || !hasCurrentDevices(),
      onSelect: resetCurrentDevices,
    },
    {
      kind: "item",
      label: "Delete all audio effects",
      disabled: !input.canWrite || !hasAudioEffects(),
      onSelect: () => {
        void input.audioEffects.removeAllFromTarget(input.targetId).catch(() => undefined);
      },
    },
    {
      kind: "item",
      label: "Hide effects panel",
      onSelect: input.onHide,
    },
  );

  return items;
};

type EffectsPanelEmptyStateProps = {
  empty: {
    visible: boolean;
    currentTargetId: string;
  };
};

const EffectsPanelEmptyState: Component<EffectsPanelEmptyStateProps> = (props) => (
  <Show when={props.empty.visible}>
    <div class="flex items-center px-4 text-sm text-muted-foreground">
      No devices on this {props.empty.currentTargetId === "master" ? "master bus" : "track"}.
      Add instruments or effects from the Browser.
    </div>
  </Show>
);

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const samplerBufferSync = untrack(() => props.samplerBufferSync);
  const drumRackBufferSync = untrack(() => props.drumRackBufferSync);
  const controller = createEffectsPanelController({
    isOpen: () => props.isOpen,
    selectedFXTarget: () => props.selectedFXTarget,
    tracks: () => props.tracks,
    sidechainRoutes: () => props.sidechainRoutes,
    audioEngine: () => props.audioEngine,
    projectId: () => props.projectId,
    userId: () => props.userId,
    playheadSec: () => props.playheadSec,
    canWriteTrackRouting: (trackId) => props.canWriteTrackRouting?.(trackId) ?? true,
    grantClipWrite: (id, scope) => props.grantClipWrite?.(id, scope),
    onClose: () => props.onClose(),
    onSelectClip: (trackId, clipId, startSec) => props.onSelectClip?.(trackId, clipId, startSec),
    insertLocalClip: (trackId, clip) => props.insertLocalClip?.(trackId, clip),
    onEffectParamsCommitted: (payload, projectId) => props.onEffectParamsCommitted?.(payload, projectId),
    onStructuralPlaybackChange: (targetId, next) => props.onStructuralPlaybackChange?.(targetId, next),
    usesLegacyAudioEngine: () => props.usesLegacyAudioEngine?.() ?? true,
    projectGeneration: () => props.projectGeneration?.() ?? 0,
    onEffectParamsPreview: (payload) => props.onEffectParamsPreview?.(payload),
    onEffectParamsFlush: (payload) => props.onEffectParamsFlush?.(payload),
    onEffectInstanceParamsReplayChange: (replay) => props.onEffectInstanceParamsReplayChange?.(replay),
    onLocalSaveFailed: (message) => props.onLocalSaveFailed?.(message),
    onDeviceInsertActionsChange: (actions) => props.onDeviceInsertActionsChange?.(actions),
    onExportSnapshotChange: (snapshot) => props.onExportSnapshotChange?.(snapshot),
    spectrumProvider: () => props.spectrumProvider,
    samplerBufferSync,
    drumRackBufferSync,
  });
  const { target, devices, spectrum, canWriteCurrentTargetEffects, isCurrentTargetReadOnly } = controller;
  const { instrument, audioEffects } = devices;
  const deviceCollapse = createEffectsPanelDeviceCollapse(() => props.projectId);
  const [externalProcessors, setExternalProcessors] = createSignal<ExternalProcessor[]>([]);
  createEffect(() => {
    const projectId = props.projectId;
    if (!projectId || !isLocalId("project", projectId)) {
      setExternalProcessors([]);
      return;
    }
    const isCurrentProject = () => untrack(() => props.projectId) === projectId;
    const reload = () => listLocalExternalProcessors(projectId)
      .then((processors) => {
        if (isCurrentProject()) setExternalProcessors(processors);
      })
      .catch(() => {
        if (isCurrentProject()) setExternalProcessors([]);
      });
    void reload();
    const unsubscribe = subscribeToLocalProjectChanges(projectId, () => void reload());
    onCleanup(unsubscribe);
  });
  const externalProcessorsForTarget = createMemo(() => (
    selectExternalProcessorsForTarget(externalProcessors(), props.selectedFXTarget)
  ));
  const removeExternalProcessor = (instanceId: string) => {
    const projectId = props.projectId;
    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    const processor = externalProcessors().find((entry) => entry.instanceId === instanceId);
    if (!processor || processor.targetId !== props.selectedFXTarget) return;
    const playbackIntent = props.captureStructuralPlaybackIntent?.();
    void deleteLocalExternalProcessor(projectId, instanceId)
      .then(() => untrack(() => props.onMixedReorderCommitted?.(playbackIntent)))
      .catch(() => undefined);
  };
  const applyExternalProcessorCommit = (
    commit: {
    previous: ExternalProcessor;
    current: ExternalProcessor;
    },
    playbackIntent?: TimelinePlaybackRebuildIntent,
  ) => {
    setExternalProcessors((processors) => processors.map((processor) => (
      processor.instanceId === commit.current.instanceId ? commit.current : processor
    )));
    if (commit.previous.bypassed !== commit.current.bypassed) {
      untrack(() => props.onExternalProcessorUpdated?.(commit.current, commit.previous, playbackIntent));
    }
  };
  const updateExternalProcessorParameter = (instanceId: string, parameterId: number, value: number) => {
    const projectId = props.projectId;
    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    void mergeLocalExternalProcessorParameterOverride(projectId, instanceId, parameterId, value)
      .then((commit) => {
        if (commit) applyExternalProcessorCommit(commit);
      })
      .catch(() => undefined);
  };
  const updateExternalProcessorBypass = (instanceId: string, bypassed: boolean) => {
    const projectId = props.projectId;
    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    const playbackIntent = props.captureStructuralPlaybackIntent?.();
    void setLocalExternalProcessorBypassed(projectId, instanceId, bypassed)
      .then((commit) => {
        if (commit) applyExternalProcessorCommit(commit, playbackIntent);
      })
      .catch(() => undefined);
  };
  const reorderMixed = (order: readonly MixedEffectOrderItem[]) => {
    const projectId = props.projectId;
    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    const targetId = props.selectedFXTarget;
    const playbackIntent = props.captureStructuralPlaybackIntent?.();
    void reorderLocalMixedEffects(projectId, targetId, order)
      .then(() => untrack(() => props.onMixedReorderCommitted?.(playbackIntent)))
      .catch(() => undefined);
  };
  const panelContextMenuItems = () => createEffectsPanelContextMenuItems({
    targetId: props.selectedFXTarget,
    targetTrackId: target.isInstrumentTrack() ? props.selectedFXTarget : undefined,
    canWrite: canWriteCurrentTargetEffects(),
    audioEffects,
    instrument,
    onHide: controller.close,
  });
  const automationRangesByInstanceId = createMemo(() => {
    const ranges = new Map<string, Map<string, { min: number; max: number }>>();
    for (const envelope of props.automationEnvelopes ?? []) {
      const targetMatches = envelope.target.kind === "master"
        ? props.selectedFXTarget === "master"
        : envelope.target.trackId === props.selectedFXTarget;
      const instanceId = envelope.target.effectInstanceId;
      if (!targetMatches || !instanceId || envelope.points.length === 0) continue;
      const range = automationEnvelopeValueRange(envelope);
      if (!range) continue;
      const instanceRanges = ranges.get(instanceId) ?? new Map<string, { min: number; max: number }>();
      instanceRanges.set(envelope.parameterId, range);
      ranges.set(instanceId, instanceRanges);
    }
    return ranges;
  });
  const synthAutomation = createMemo(() => {
    const synthInstanceId = instrument.synth.instanceId();
    return createSynthAutomationState(
      props.selectedFXTarget === "master" ? undefined : props.selectedFXTarget,
      synthInstanceId,
      props.automationEnvelopes ?? [],
    );
  });
  const synthAutomationDisplayParams = createMemo(() => {
    const params = instrument.synth.params();
    return params
      ? overlaySynthAutomationValues(params, synthAutomation().parameterIds, props.evaluatedValuesByTargetKey)
      : undefined;
  });

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
          <TimelineContextMenu items={panelContextMenuItems}>
            <div class="flex h-full min-h-0 flex-col">
              <div class="flex flex-1 flex-col overflow-hidden min-h-0">
                <div
                  class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-1 py-1"
                >
                  <div class="flex h-full min-h-0 min-w-min items-stretch gap-3">
                    <Show when={target.isInstrumentTrack()}>
                      <EffectsPanelInstrumentSection
                        instrument={{
                          state: instrument,
                          canWrite: canWriteCurrentTargetEffects(),
                        }}
                        audioEngine={props.audioEngine}
                        targetId={props.selectedFXTarget}
                        projectId={props.projectId}
                        onPreviewNote={props.onPreviewNote}
                        synthAutomationRangesByParameterId={synthAutomation().ranges}
                        synthAutomationParameterIds={synthAutomation().parameterIds}
                        synthAutomationDisplayParams={synthAutomationDisplayParams()}
                        onSelectSynthAutomationParameter={(parameterId) => props.onSelectAutomationParameter?.(props.selectedFXTarget, parameterId)}
                        onManualSynthAutomationOverride={(parameterId) => props.onManualAutomationOverride?.(props.selectedFXTarget, parameterId)}
                        deviceCollapse={deviceCollapse}
                      />
                    </Show>
                    <EffectsPanelEffectCards
                      projectId={props.projectId}
                      audioEffects={audioEffects}
                      externalProcessors={externalProcessorsForTarget()}
                      externalInstrument={externalProcessorsForTarget().find((processor) => processor.manifest.role === "instrument")}
                      enqueueParameter={props.enqueueNativeVstParameter ?? (() => Promise.resolve("rejected"))}
                      canWrite={canWriteCurrentTargetEffects()}
                      onElementChange={props.onEffectChainElementChange}
                      spectrum={spectrum()}
                      audioEngine={props.audioEngine}
                      targetId={props.selectedFXTarget}
                      tracks={props.tracks}
                      sidechainRoutes={props.sidechainRoutes}
                      automationRangesByInstanceId={automationRangesByInstanceId()}
                      evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
                      onSelectAutomationParameter={(parameterId, effectInstanceId) => props.onSelectAutomationParameter?.(props.selectedFXTarget, parameterId, effectInstanceId)}
                      onManualAutomationOverride={(parameterId, effectInstanceId) => props.onManualAutomationOverride?.(props.selectedFXTarget, parameterId, effectInstanceId)}
                      autoOpenExternalProcessorId={props.autoOpenExternalProcessorId}
                      onExternalProcessorAutoOpenHandled={props.onExternalProcessorAutoOpenHandled}
                      onRemoveExternalProcessor={removeExternalProcessor}
                      onExternalParameterChange={updateExternalProcessorParameter}
                      onExternalBypassChange={updateExternalProcessorBypass}
                      onMixedReorder={reorderMixed}
                      deviceCollapse={deviceCollapse}
                    />
                    <Show when={isCurrentTargetReadOnly()}>
                      <EffectsPanelReadOnlyNotice />
                    </Show>
                    <EffectsPanelEmptyState
                      empty={{
                        visible:
                          audioEffects.orderedEffects().length === 0 &&
                          externalProcessorsForTarget().length === 0 &&
                          !instrument.arp.params() &&
                          (!instrument.activeInstrument() ||
                            !target.isInstrumentTrack()),
                        currentTargetId: target.currentTargetId(),
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </TimelineContextMenu>
        </TimelineBottomPanelShell>
      </Show>

      <Show when={!props.isOpen && props.showOpenButton}>
        <EffectsPanelClosedFooter onOpen={props.onOpen} clipTab={props.clipTab} />
      </Show>
    </>
  );
};

export default EffectsPanel;
