import { type Component, Show, Match, Switch } from "solid-js";
import { AUDIO_EFFECT_CONTRACTS, automationTargetKey, isJsonObject, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeGateParamsEnvelope, normalizeLimiterParamsEnvelope, normalizeReverbParams, normalizeSaturatorParams, normalizeSpectralParamsEnvelope, normalizeUtilityParamsEnvelope, type AudioEffectInstance, type AudioEffectKind, type JsonObject } from "@daw-browser/shared";
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
import Spectrum from "~/components/effects/Spectrum";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import type { EffectsPanelAudioEffects } from "~/components/timeline/create-effects-panel-controller";
import { registerAudioEffectCardInteractionCleanup } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { overlayEffectAutomationValue } from "~/components/timeline/effect-automation-display";
import type { TimelineContextMenuItem } from "~/components/timeline/context-menu/timeline-context-menu";
import { getAudioEffectDeviceCatalogEntry } from "~/lib/device-catalog";
import { settleReportedAction } from "~/components/timeline/reported-action-outcome";
import { ParameterGestureProvider } from "~/components/effects/effect-parameter-interaction";

type EffectsPanelAudioEffectCardProps = {
  effect: AudioEffectInstance;
  audioEffects: EffectsPanelAudioEffects;
  projectId?: string;
  projectGeneration: number;
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

export const createAudioEffectContextMenuItems = (input: {
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

export const createAudioEffectContextMenuControls = (
  effect: AudioEffectInstance,
  audioEffects: EffectsPanelAudioEffects,
  targetId?: Track["id"] | "master",
) => {
  const remove = targetId
    ? () => {
      void settleReportedAction(audioEffects.removeByInstanceFromTarget(targetId, effect));
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

  if (effect.kind === "spectrum") return { label: audioEffectLabel("spectrum"), enabled: () => AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.spectrum.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.spectrum.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.spectrum.createDefaultParams()), remove };

  if (effect.kind === "spectral") return { label: audioEffectLabel("spectral"), enabled: () => normalizeSpectralParamsEnvelope(effectParamsInput(audioEffects.paramsForInstance(effect))).state.enabled, toggleEnabled: (enabled: boolean) => audioEffects.spectral.changeInstance(effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } })), reset: () => audioEffects.spectral.changeInstance(effect.id, () => AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams()), remove };

  return {
    label: audioEffectLabel("reverb"),
    enabled: () => normalizeReverbParams(effectParamsInput(audioEffects.paramsForInstance(effect))).enabled !== false,
    toggleEnabled: (enabled: boolean) => audioEffects.reverb.changeInstance(effect.id, (prev) => ({ ...prev, enabled })),
    reset: () => audioEffects.reverb.changeInstance(effect.id, () => normalizeReverbParams({})),
    remove,
  };
};

export const EffectsPanelAudioEffectCard: Component<EffectsPanelAudioEffectCardProps> = (props) => {
  registerAudioEffectCardInteractionCleanup({
    effectId: () => props.effect.id,
    audioEffects: () => props.audioEffects,
    targetId: () => props.targetId,
    ownerKey: () => `${props.projectId ?? ""}:${props.projectGeneration}:${props.effect.id}`,
  });
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
    <ParameterGestureProvider owner={props.audioEffects.gestureOwner(props.effect.id, props.effect.kind, props.targetId)}>
    <Switch>
      <Match when={props.effect.kind === "utility"}>
        <Show when={displayedParams()}>{(value) => <Utility
          params={normalizeUtilityParamsEnvelope(value()).state}
          onChange={(updates) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => normalizeUtilityParamsEnvelope({ ...prev, state: { ...prev.state, ...updates } }))}
          onToggleEnabled={(enabled) => props.audioEffects.utility.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))}
          onReset={() => props.audioEffects.utility.changeInstance(props.effect.id, () => normalizeUtilityParamsEnvelope({}))}
          automationRangesByParameterId={props.automationRangesByParameterId}
          onAutomationParameterTouch={props.onSelectAutomationParameter}
          onManualAutomationOverride={props.onManualAutomationOverride}
        />}</Show>
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

          return <Eq params={eq()} onBandChange={(bandId, updates) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, ...updates } : band) }))} onParamsChange={(updates) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => normalizeEqParams({ ...prev, ...updates }))} onBandToggle={(bandId) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, bands: prev.bands.map((band) => band.id === bandId ? { ...band, enabled: !band.enabled } : band) }))} onToggleEnabled={(enabled) => props.audioEffects.eq.changeInstance(props.effect.id, (prev) => ({ ...prev, enabled }))} onReset={() => props.audioEffects.eq.changeInstance(props.effect.id, () => normalizeEqParams({}))} spectrumData={props.spectrum} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onSelectAutomationParameter} onManualAutomationOverride={props.onManualAutomationOverride} />
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
      <Match when={props.effect.kind === "spectrum"}>
        <Show when={displayedParams()}>{(value) => <Spectrum params={AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams(value()).state} frame={props.spectrum} onChange={(updates) => props.audioEffects.spectrum.changeInstance(props.effect.id, (prev) => AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams({ ...prev, state: { ...prev.state, ...updates } }))} onToggleEnabled={(enabled) => props.audioEffects.spectrum.changeInstance(props.effect.id, (prev) => ({ ...prev, state: { ...prev.state, enabled } }))} onReset={() => props.audioEffects.spectrum.changeInstance(props.effect.id, () => AUDIO_EFFECT_CONTRACTS.spectrum.createDefaultParams())} />}</Show>
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
    </ParameterGestureProvider>
  );
};
