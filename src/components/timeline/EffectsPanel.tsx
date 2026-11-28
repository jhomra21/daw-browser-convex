import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDelivery, PublicationJoin } from "~/lib/live-processor-control";
import { type Component, Show, Match, Switch, For, type JSX, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import { automationEnvelopeValueRange, isLocalId, type AudioEffectInstance, type AutomationEnvelope, type SynthParams, type TrackInstrumentParams } from "@daw-browser/shared";
import Arpeggiator from "~/components/effects/Arpeggiator";
import Synth from "~/components/effects/Synth";
import DrumRack from "~/components/effects/DrumRack";
import Sampler from "~/components/effects/Sampler";
import Granular from "~/components/effects/Granular";
import type { AudioEngine, EngineDisposition, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { OptimisticGrantWrite } from "~/lib/optimistic-grant-scope";
import type { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { createSamplerBufferSync, NativeInstrumentRetryIdentity } from "~/lib/sampler-buffer-sync";
import type { EffectParamsCommitOptions, EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import type { NativeBuiltInParameterPayload } from "~/lib/processor-edit-semantics";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import type { Clip, ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { BOTTOM_PANEL_EDGE_PADDING_PX } from "~/lib/bottom-panel-layout";
import type { TimelineDeviceInsertActions } from "~/lib/timeline-device-insert-actions";
import type { TimelineEditIntent } from "~/hooks/timeline-playback-types";
import { createEffectsPanelController, type EffectsPanelAudioEffects, type EffectsPanelInstrumentDevice } from "~/components/timeline/create-effects-panel-controller";
import { createEffectCardReorderDrag, type EffectCardReorderPreview } from "~/components/timeline/create-effect-card-reorder-drag";
import TimelineContextMenu, { type TimelineContextMenuItem } from "~/components/timeline/context-menu/timeline-context-menu";
import { CONTEXT_MENU_AUDIO_EFFECT_CATALOG, CONTEXT_MENU_INSTRUMENT_CATALOG, CONTEXT_MENU_MIDI_EFFECT_CATALOG } from "~/lib/device-catalog";
import { isEditableKeyboardTarget } from "~/lib/keyboard-event-target";
import { createSynthAutomationState, overlaySynthAutomationValues } from "~/components/timeline/synth-automation";
import { deleteLocalExternalProcessor, listLocalExternalProcessors, mergeLocalExternalProcessorParameterOverride, setLocalExternalProcessorBypassed } from "~/lib/external-plugins";
import { reorderLocalMixedEffects } from "~/lib/local-effects";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { selectExternalProcessorsForTarget } from "~/lib/external-plugin-ui";
import { ExternalPluginCard, nativeEditorAnchorFromElement } from "~/components/timeline/external-plugin-card";
import type { PlaybackAcceptanceObserver } from "~/lib/desktop/acceptance-observer";
import { instanceLimit } from "~/lib/desktop/vst-instance-failures";
import type { NativeVstParameterQueue } from "~/lib/desktop/native-vst-parameter-queue";
import type { MixedEffectOrderItem } from "~/lib/mixed-effect-order";
import { createEffectsPanelDeviceCollapse, DeviceCollapseProvider, safeDeviceContentId, deviceCollapseIdentity, type DeviceCollapseIdentity } from "~/components/timeline/create-effects-panel-device-collapse";
import { isDeviceInteractiveTarget } from "~/components/timeline/device-interaction";
import { settleReportedAction } from "~/components/timeline/reported-action-outcome";
import { ParameterGestureProvider } from "~/components/effects/effect-parameter-interaction";
import { EffectsPanelAudioEffectCard, createAudioEffectContextMenuControls, createAudioEffectContextMenuItems } from "~/components/timeline/EffectsPanelAudioEffectCard";

type EffectsPanelProps = {
  acceptance?: PlaybackAcceptanceObserver;
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
  onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string, options?: EffectParamsCommitOptions) => void;
  onStructuralPlaybackChange?: (targetId: Track["id"], next: TrackInstrumentParams | undefined, edit?: LiveProcessorEditIdentity) => Promise<void>;
  usesLegacyAudioEngine?: () => boolean;
  projectGeneration?: () => number;
  allocateProcessorEdit?: (payload: NativeBuiltInParameterPayload) => LiveProcessorEditIdentity | undefined;
  deliverProcessor?: (edit: LiveProcessorEditIdentity, gesture?: ProcessorDelivery["gesture"]) => DeliveryRegistration;
  applyPortableProcessor?: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined>;
  joinPublication?: (join: PublicationJoin) => DeliveryRegistration;
  onPreviewNote?: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void;
  onEffectInstanceParamsReplayChange?: Parameters<typeof createEffectsPanelController>[0]["onEffectInstanceParamsReplayChange"];
  onLocalSaveFailed?: (projectId: string, message: string) => void;
  onEffectError?: (title: string, message: string) => void;
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
    intent?: TimelineEditIntent,
  ) => void;
  captureStructuralPlaybackIntent?: () => TimelineEditIntent;
  onMixedReorderCommitted?: (intent?: TimelineEditIntent) => void;
  enqueueNativeVstParameter?: NativeVstParameterQueue["enqueue"];
  requestNativeVstStateCapture?: (instanceId: string) => void;
  spectrumProvider?: (targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void;
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>;
  retryNativeInstrumentPreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>;
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
  // The effect or processor instance id the native limitation (E6) is keyed by, for a device that has one.
  instanceId?: string;
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
      nativeLimit={() => props.instanceId === undefined ? undefined : instanceLimit(props.instanceId)}
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
          <ParameterGestureProvider owner={props.instrument.state.arp.gestureOwner}>
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
          </ParameterGestureProvider>
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
          <ParameterGestureProvider owner={props.instrument.state.gestureOwner}>
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
              nativeStatus={props.instrument.state.drumRack.nativeStatus()}
              onRetry={props.instrument.state.drumRack.retry}
              onReset={props.instrument.state.drumRack.reset}
              onUpdatePad={props.instrument.state.drumRack.updatePad}
            />
          </ParameterGestureProvider>
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
          <ParameterGestureProvider owner={props.instrument.state.gestureOwner}>
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
          </ParameterGestureProvider>
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
          <ParameterGestureProvider owner={props.instrument.state.gestureOwner}>
            <Granular
              params={params()}
              status={props.instrument.state.granular.status()}
              canWrite={props.instrument.canWrite}
              onReset={props.instrument.state.granular.reset}
              onRetry={props.instrument.state.granular.retry}
              onUpdate={props.instrument.state.granular.update}
            />
          </ParameterGestureProvider>
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
          <ParameterGestureProvider owner={props.instrument.state.gestureOwner}>
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
          </ParameterGestureProvider>
        </EffectsPanelDeviceBoundary>
      )}
    </Show>
  </div>
);

type EffectsPanelEffectCardsProps = {
  acceptance?: PlaybackAcceptanceObserver;
  projectId?: string;
  projectGeneration: number;
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
  onExternalParameterGestureEnd?: (instanceId: string) => void;
  onExternalBypassChange: (instanceId: string, bypassed: boolean) => void;
  onMixedReorder: (order: readonly MixedEffectOrderItem[]) => void;
  deviceCollapse: ReturnType<typeof createEffectsPanelDeviceCollapse>;
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
    void settleReportedAction(props.audioEffects.removeByInstanceFromTarget(props.targetId, effect));
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
              instanceId={processor().instanceId}
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
                  acceptance={props.acceptance}
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
                  onParameterGestureEnd={() => props.onExternalParameterGestureEnd?.(processor().instanceId)}
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
                              instanceId={processor().instanceId}
                              canWrite={props.canWrite}
                              collapse={props.deviceCollapse}
                              menuItems={() => externalProcessorContextMenuItems(processor())}
                            >
                              <ExternalPluginCard
                                acceptance={props.acceptance}
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
                                onParameterGestureEnd={() => props.onExternalParameterGestureEnd?.(processor().instanceId)}
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
                              instanceId={effect().id}
                              canWrite={props.canWrite}
                              collapse={props.deviceCollapse}
                              menuItems={() => contextMenuItems(effect())}
                            >
                              <EffectsPanelAudioEffectCard
                                effect={effect()}
                                audioEffects={props.audioEffects}
                                projectId={props.projectId}
                                projectGeneration={props.projectGeneration}
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
                    <EffectsPanelAudioEffectCard effect={effect()} audioEffects={props.audioEffects} projectId={props.projectId} projectGeneration={props.projectGeneration} spectrum={props.spectrum} targetId={props.targetId} />
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
      void settleReportedAction(input.audioEffects.addByKindToTarget(input.targetId, entry.kind));
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
        void settleReportedAction(input.audioEffects.removeAllFromTarget(input.targetId));
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
  const retryNativeInstrumentPreparation = untrack(() => props.retryNativeInstrumentPreparation);
  const allocateProcessorEdit = untrack(() => props.allocateProcessorEdit);
  const deliverProcessor = untrack(() => props.deliverProcessor);
  const joinPublication = untrack(() => props.joinPublication);

  const controller = createEffectsPanelController({
    acceptance: untrack(() => props.acceptance),
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
    onEffectParamsCommitted: (payload, projectId, options) => props.onEffectParamsCommitted?.(payload, projectId, options),
    onStructuralPlaybackChange: async (targetId, next, edit) => props.onStructuralPlaybackChange?.(targetId, next, edit),
    usesLegacyAudioEngine: () => props.usesLegacyAudioEngine?.() ?? true,
    projectGeneration: () => props.projectGeneration?.() ?? 0,
    allocateProcessorEdit,
    deliverProcessor,
    applyPortableProcessor: (edit) => props.applyPortableProcessor?.(edit) ?? Promise.resolve(undefined),
    joinPublication,
    retryNativeInstrumentPreparation,
    onEffectInstanceParamsReplayChange: (replay) => props.onEffectInstanceParamsReplayChange?.(replay),
    onLocalSaveFailed: (projectId, message) => props.onLocalSaveFailed?.(projectId, message),
    onEffectError: (title, message) => props.onEffectError?.(title, message),
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
    props.acceptance?.ui("ui-device-remove", () => instanceId);
    void settleReportedAction(deleteLocalExternalProcessor(projectId, instanceId))
      .then((outcome) => {
        if (outcome.ok) untrack(() => props.onMixedReorderCommitted?.(playbackIntent));
      });
  };

  const applyExternalProcessorCommit = (
    commit: {
    previous: ExternalProcessor;
    current: ExternalProcessor;
    },
    playbackIntent?: TimelineEditIntent,
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
    void settleReportedAction(mergeLocalExternalProcessorParameterOverride(projectId, instanceId, parameterId, value))
      .then((outcome) => {
        if (outcome.ok && outcome.value) applyExternalProcessorCommit(outcome.value);
      });
  };

  const updateExternalProcessorBypass = (instanceId: string, bypassed: boolean) => {
    const projectId = props.projectId;

    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    const playbackIntent = props.captureStructuralPlaybackIntent?.();
    void settleReportedAction(setLocalExternalProcessorBypassed(projectId, instanceId, bypassed))
      .then((outcome) => {
        if (outcome.ok && outcome.value) applyExternalProcessorCommit(outcome.value, playbackIntent);
      });
  };

  const reorderMixed = (order: readonly MixedEffectOrderItem[]) => {
    const projectId = props.projectId;

    if (!projectId || !isLocalId("project", projectId) || !canWriteCurrentTargetEffects()) return;
    const targetId = props.selectedFXTarget;
    const playbackIntent = props.captureStructuralPlaybackIntent?.();
    void settleReportedAction(reorderLocalMixedEffects(projectId, targetId, order))
      .then((outcome) => {
        if (outcome.ok) untrack(() => props.onMixedReorderCommitted?.(playbackIntent));
      });
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
                      acceptance={props.acceptance}
                      projectId={props.projectId}
                      projectGeneration={props.projectGeneration?.() ?? 0}
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
                      onExternalParameterGestureEnd={props.requestNativeVstStateCapture}
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
