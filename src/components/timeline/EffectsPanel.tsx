import {
  type Component,
  Show,
  For,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { AUDIO_EFFECT_CONTRACTS, automationEnvelopeValueRange, automationTargetKey, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams, normalizeSpectralParamsEnvelope, normalizeUtilityParamsEnvelope, type AudioEffectInstance, type AudioEffectKind, type AutomationEnvelope } from "@daw-browser/shared";
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
import SynthCard from "~/components/effects/SynthCard";
import DrumRack from "~/components/effects/DrumRack";
import Sampler from "~/components/effects/Sampler";
import Granular from "~/components/effects/Granular";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import type { Clip, ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
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
  onEffectInstanceParamsReplayChange?: Parameters<typeof createEffectsPanelController>[0]["onEffectInstanceParamsReplayChange"];
  onLocalSaveFailed?: (message: string) => void;
  onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void;
  onEffectChainElementChange?: (element: HTMLElement | undefined) => void;
  automationEnvelopes?: AutomationEnvelope[];
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (targetKey: Track["id"] | "master", parameterId: string, effectInstanceId?: string) => void;
  onManualAutomationOverride?: (targetKey: Track["id"] | "master", parameterId: string, effectInstanceId?: string) => void;
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

    <Show when={props.instrument.state.drumRack.params()}>
      {(params) => (
        <DrumRack
          params={params()}
          targetId={props.targetId}
          audioEngine={props.audioEngine}
          canWrite={props.instrument.canWrite}
          onAssignSampleToPad={props.instrument.state.drumRack.assignSampleToPad}
          onReset={props.instrument.state.drumRack.reset}
          onUpdatePad={props.instrument.state.drumRack.updatePad}
        />
      )}
    </Show>
    <Show when={props.instrument.state.sampler.params()}>
      {(params) => (
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
      )}
    </Show>
    <Show when={props.instrument.state.granular.params()}>
      {(params) => (
        <Granular
          params={params()}
          status={props.instrument.state.granular.status()}
          canWrite={props.instrument.canWrite}
          onReset={props.instrument.state.granular.reset}
          onRetry={props.instrument.state.granular.retry}
          onUpdate={props.instrument.state.granular.update}
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
      <div class="flex min-w-48 items-center justify-between border border-border bg-app-surface px-2 py-2 text-muted-foreground">
        <span class="text-xs">Synth is expanded</span>
        <button
          class="border border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
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
  audioEngine: AudioEngine;
  targetId: Track["id"] | "master";
  tracks: Track[];
  sidechainRoutes: ExternalSidechainRoute[];
  automationRangesByInstanceId?: ReadonlyMap<string, ReadonlyMap<string, { min: number; max: number }>>;
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (parameterId: string, effectInstanceId: string) => void;
  onManualAutomationOverride?: (parameterId: string, effectInstanceId: string) => void;
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
const objectParams = (value: unknown): object => value && typeof value === "object" ? value : {};

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
      enabled: () => normalizeEqParams(objectParams(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.eq.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.eq.changeInstance(effect.id, () => normalizeEqParams({})),
      remove,
    };
  }
  if (effect.kind === "utility") {
    return {
      label: audioEffectLabel("utility"),
      enabled: () => normalizeUtilityParamsEnvelope(audioEffects.paramsForInstance(effect)).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.utility.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.utility.changeInstance(effect.id, () => normalizeUtilityParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "gate") {
    return {
      label: audioEffectLabel("gate"),
      enabled: () => normalizeGateParamsEnvelope(audioEffects.paramsForInstance(effect)).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.gate.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.gate.changeInstance(effect.id, () => normalizeGateParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "compressor") {
    return {
      label: audioEffectLabel("compressor"),
      enabled: () => normalizeCompressorParams(objectParams(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.compressor.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.compressor.changeInstance(effect.id, () => normalizeCompressorParams({})),
      remove,
    };
  }
  if (effect.kind === "limiter") {
    return {
      label: audioEffectLabel("limiter"),
      enabled: () => normalizeLimiterParamsEnvelope(audioEffects.paramsForInstance(effect)).state.enabled,
      toggleEnabled: (enabled: boolean) => audioEffects.limiter.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })),
      reset: () => audioEffects.limiter.changeInstance(effect.id, () => normalizeLimiterParamsEnvelope({})),
      remove,
    };
  }
  if (effect.kind === "saturator") {
    return {
      label: audioEffectLabel("saturator"),
      enabled: () => normalizeSaturatorParams(objectParams(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.saturator.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.saturator.changeInstance(effect.id, () => normalizeSaturatorParams({})),
      remove,
    };
  }
  if (effect.kind === "delay") {
    return {
      label: audioEffectLabel("delay"),
      enabled: () => normalizeDelayParams(objectParams(audioEffects.paramsForInstance(effect))).enabled !== false,
      toggleEnabled: (enabled: boolean) => audioEffects.delay.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
      reset: () => audioEffects.delay.changeInstance(effect.id, () => normalizeDelayParams({})),
      remove,
    };
  }
  if (effect.kind === "autofilter") return { label: audioEffectLabel("autofilter"), enabled: () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.autofilter.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.autofilter.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({})), remove };
  if (effect.kind === "chorus") return { label: audioEffectLabel("chorus"), enabled: () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.chorus.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.chorus.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({})), remove };
  if (effect.kind === "flanger") return { label: audioEffectLabel("flanger"), enabled: () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.flanger.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.flanger.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({})), remove };
  if (effect.kind === "phaser") return { label: audioEffectLabel("phaser"), enabled: () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.phaser.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.phaser.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({})), remove };
  if (effect.kind === "tremolo") return { label: audioEffectLabel("tremolo"), enabled: () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.tremolo.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.tremolo.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({})), remove };
  if (effect.kind === "autopan") return { label: audioEffectLabel("autopan"), enabled: () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.autopan.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.autopan.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({})), remove };
  if (effect.kind === "ensemble") return { label: audioEffectLabel("ensemble"), enabled: () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.ensemble.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.ensemble.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({})), remove };
  if (effect.kind === "lofi") return { label: audioEffectLabel("lofi"), enabled: () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.lofi.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.lofi.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({})), remove };
  if (effect.kind === "spectral") return { label: audioEffectLabel("spectral"), enabled: () => normalizeSpectralParamsEnvelope(audioEffects.paramsForInstance(effect)).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.spectral.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.spectral.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams()), remove };
  return {
    label: audioEffectLabel("reverb"),
    enabled: () => normalizeReverbParams(objectParams(audioEffects.paramsForInstance(effect))).enabled !== false,
    toggleEnabled: (enabled: boolean) => audioEffects.reverb.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
    reset: () => audioEffects.reverb.changeInstance(effect.id, () => normalizeReverbParams({})),
    remove,
  };
};

const EffectsPanelAudioEffectCard: Component<EffectsPanelAudioEffectCardProps> = (props) => {
  const params = () => props.audioEffects.paramsForInstance(props.effect);
  const displayedParams = () => {
    const targetId = props.targetId;
    if (!targetId) return params();
    let next: unknown = params();
    const ranges = props.automationRangesByParameterId;
    const values = props.evaluatedValuesByTargetKey;
    if (!next || !ranges || !values) return next;
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
  if (props.effect.kind === "utility") {
    return <Show when={displayedParams()}>{(value) => <Utility params={normalizeUtilityParamsEnvelope(value()).state} onChange={(updates) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => normalizeUtilityParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.utility.changeInstance(props.effect.id, () => normalizeUtilityParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "gate") {
    const sourceTrackId = () => props.sidechainRoutes?.find((route) => route.targetTrackId === props.targetId && route.effectInstanceId === props.effect.id)?.sourceTrackId;
    return <Show when={displayedParams()}>{(value) => <Gate params={normalizeGateParamsEnvelope(value()).state} tracks={props.tracks ?? []} targetId={props.targetId ?? "master"} effectInstanceId={props.effect.id} audioEngine={props.audioEngine} sourceTrackId={sourceTrackId()} onSourceChange={(source) => void props.audioEffects.gate.setSidechainSource(props.effect.id, source)} onChange={(updates) => props.audioEffects.gate.changeInstance(props.effect.id, (prev) => normalizeGateParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.gate.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.gate.changeInstance(props.effect.id, () => normalizeGateParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "limiter") {
    return <Show when={displayedParams()}>{(value) => <Limiter params={normalizeLimiterParamsEnvelope(value()).state} targetId={props.targetId ?? "master"} effectInstanceId={props.effect.id} audioEngine={props.audioEngine} onChange={(updates) => props.audioEffects.limiter.changeInstance(props.effect.id, (prev) => normalizeLimiterParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.limiter.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.limiter.changeInstance(props.effect.id, () => normalizeLimiterParamsEnvelope({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "lofi") {
    return <Show when={displayedParams()}>{(value) => <LoFi params={AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.lofi.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.lofi.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.lofi.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "autofilter") {
    return <Show when={displayedParams()}>{(value) => <AutoFilter params={AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.autofilter.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.autofilter.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.autofilter.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "chorus") {
    return <Show when={displayedParams()}>{(value) => <Chorus params={AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.chorus.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.chorus.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.chorus.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "flanger") {
    return <Show when={displayedParams()}>{(value) => <Flanger params={AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.flanger.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.flanger.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.flanger.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "phaser") {
    return <Show when={displayedParams()}>{(value) => <Phaser params={AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.phaser.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.phaser.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.phaser.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "tremolo") {
    return <Show when={displayedParams()}>{(value) => <Tremolo params={AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.tremolo.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.tremolo.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.tremolo.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "autopan") {
    return <Show when={displayedParams()}>{(value) => <AutoPan params={AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.autopan.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.autopan.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.autopan.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "ensemble") {
    return <Show when={displayedParams()}>{(value) => <Ensemble params={AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(value()).state} onChange={(updates) => props.audioEffects.ensemble.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.ensemble.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.ensemble.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}</Show>;
  }
  if (props.effect.kind === "eq") {
    return (
      <Show when={displayedParams()}>
        {(value) => {
          const eq = () => normalizeEqParams(objectParams(value()));
          return <Eq bands={eq().bands} enabled={eq().enabled} channelMode={eq().channelMode} onBandChange={(bandId, updates) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band) }))} onChannelModeChange={(channelMode) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => prev.channelMode === channelMode ? prev : normalizeEqParams({ ...prev, channelMode }))} onBandToggle={(bandId) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band) }))} onToggleEnabled={(enabled) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.eq.changeInstance(props.effect.id, () => normalizeEqParams({}))} spectrumData={props.spectrum} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />;
        }}
      </Show>
    );
  }
  if (props.effect.kind === "saturator") {
    return (
      <Show when={displayedParams()}>
        {(value) => <Saturator params={normalizeSaturatorParams(objectParams(value()))} onChange={(updates) => props.audioEffects.saturator.changeInstance(props.effect.id, (prev) => normalizeSaturatorParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.saturator.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.saturator.changeInstance(props.effect.id, () => normalizeSaturatorParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
      </Show>
    );
  }
  if (props.effect.kind === "compressor") {
    return (
      <Show when={displayedParams()}>
        {(value) => <Compressor params={normalizeCompressorParams(objectParams(value()))} audioEngine={props.audioEngine} targetId={props.targetId} onChange={(updates) => props.audioEffects.compressor.changeInstance(props.effect.id, (prev) => normalizeCompressorParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.compressor.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.compressor.changeInstance(props.effect.id, () => normalizeCompressorParams({}))} />}
      </Show>
    );
  }
  if (props.effect.kind === "delay") {
    return (
      <Show when={displayedParams()}>
        {(value) => <Delay params={normalizeDelayParams(objectParams(value()))} onChange={(updates) => props.audioEffects.delay.changeInstance(props.effect.id, (prev) => normalizeDelayParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.delay.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.delay.changeInstance(props.effect.id, () => normalizeDelayParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
      </Show>
    );
  }
  if (props.effect.kind === "spectral") {
    const sourceTrackId = () => props.sidechainRoutes?.find((route) => route.targetTrackId === props.targetId && route.effectInstanceId === props.effect.id)?.sourceTrackId;
    return (
      <Show when={displayedParams()}>
        {(value) => (
          <Spectral
            params={normalizeSpectralParamsEnvelope(value()).state}
            tracks={props.tracks ?? []}
            targetId={props.targetId ?? "master"}
            sourceTrackId={sourceTrackId()}
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
    );
  }
  return (
    <Show when={displayedParams()}>
      {(value) => <Reverb params={normalizeReverbParams(objectParams(value()))} onChange={(updates) => props.audioEffects.reverb.changeInstance(props.effect.id, (prev) => normalizeReverbParams({ ...prev, ...updates }))} onToggleEnabled={(enabled) => props.audioEffects.reverb.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.reverb.changeInstance(props.effect.id, () => normalizeReverbParams({}))} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />}
    </Show>
  );
};

const EffectsPanelEffectCards: Component<EffectsPanelEffectCardsProps> = (props) => {
  const [reorderPreview, setReorderPreview] = createSignal<EffectCardReorderPreview>();
  const contextMenuItems = (effect: AudioEffectInstance): TimelineContextMenuItem[] => {
    return createAudioEffectContextMenuItems({
      ...createAudioEffectContextMenuControls(effect, props.audioEffects, props.targetId),
      canWrite: props.canWrite,
    });
  };

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
                data-effect-kind={effect.kind}
                data-effect-id={effect.id}
                class="touch-none transition-opacity"
                classList={{ "opacity-30": reorderPreview()?.effect === effect }}
                onPointerDown={drag.onPointerDown}
              >
                <TimelineContextMenu items={() => contextMenuItems(effect)}>
                  <EffectsPanelAudioEffectCard
                    effect={effect}
                    audioEffects={props.audioEffects}
                    spectrum={props.spectrum}
                    audioEngine={props.audioEngine}
                    targetId={props.targetId}
                    tracks={props.tracks}
                    sidechainRoutes={props.sidechainRoutes}
                    automationRangesByParameterId={props.automationRangesByInstanceId?.get(effect.id)}
                    evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
                    onSelectAutomationParameter={(parameterId) => props.onSelectAutomationParameter?.(parameterId, effect.id)}
                    onManualAutomationOverride={(parameterId) => props.onManualAutomationOverride?.(parameterId, effect.id)}
                  />
                </TimelineContextMenu>
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
    sidechainRoutes: () => props.sidechainRoutes,
    audioEngine: () => props.audioEngine,
    projectId: () => props.projectId,
    userId: () => props.userId,
    playheadSec: () => props.playheadSec,
    canWriteTrackRouting: props.canWriteTrackRouting,
    grantClipWrite: props.grantClipWrite,
    onClose: props.onClose,
    onSelectClip: props.onSelectClip,
    insertLocalClip: props.insertLocalClip,
    onEffectParamsCommitted: props.onEffectParamsCommitted,
    onEffectInstanceParamsReplayChange: props.onEffectInstanceParamsReplayChange,
    onLocalSaveFailed: props.onLocalSaveFailed,
    onDeviceInsertActionsChange: props.onDeviceInsertActionsChange,
  });
  const { target, devices, spectrum, canWriteCurrentTargetEffects, isCurrentTargetReadOnly } = controller;
  const { instrument, audioEffects } = devices;
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
                      />
                    </Show>
                    <EffectsPanelEffectCards
                      audioEffects={audioEffects}
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
                    />
                    <Show when={isCurrentTargetReadOnly()}>
                      <EffectsPanelReadOnlyNotice />
                    </Show>
                    <EffectsPanelEmptyState
                      empty={{
                        visible:
                          audioEffects.orderedEffects().length === 0 &&
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

      <EffectsPanelFloatingSynth synth={instrument.synth} canWrite={canWriteCurrentTargetEffects()} />
    </>
  );
};

export default EffectsPanel;
