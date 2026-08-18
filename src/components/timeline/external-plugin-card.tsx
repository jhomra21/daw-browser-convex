import { For, Show, createEffect, createSignal, onCleanup, untrack, type Component } from "solid-js";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import type { PluginParameterDescriptor } from "@daw-browser/plugin-host-protocol";
import { encodeNativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol";
import { automationTargetKey, externalAutomationParameterId } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import type { NativeVstParameterQueue } from "~/lib/desktop/native-vst-parameter-queue";
import { externalProcessorStatusLabel } from "~/lib/external-plugin-ui";
import {
  nativeEditorAnchorFromElement,
  nativeEditorAvailabilityMessage,
  nativeEditorCommandAvailable,
} from "~/components/timeline/external-plugin-editor";
import { isDeviceHeaderTarget, isDeviceInteractiveTarget } from "~/components/timeline/device-interaction";
import EffectShell from "~/components/effects/EffectShell";
import { compileNativeExternalEditorPlan } from "~/lib/desktop/native-external-attachment-plan";

type ExternalPluginParametersProps = {
  processor: ExternalProcessor;
  enqueueParameter: NativeVstParameterQueue["enqueue"];
  targetId: Track["id"] | "master";
  canWrite: boolean;
  automationRanges?: ReadonlyMap<string, { min: number; max: number }>;
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (parameterId: string, effectInstanceId: string) => void;
  onManualAutomationOverride?: (parameterId: string, effectInstanceId: string) => void;
  onParameterChange: (parameterId: number, value: number) => void;
};

const ExternalPluginParameters: Component<ExternalPluginParametersProps> = (props) => {
  const visibleParameters = () => props.processor.manifest.parameters.filter((parameter) => !parameter.hidden);
  const [expanded, setExpanded] = createSignal(visibleParameters().length <= 8);
  const normalizedValue = (parameter: PluginParameterDescriptor) => {
    const value = props.processor.parameterOverrides[String(parameter.id)];
    return value !== undefined && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : Math.min(1, Math.max(0, parameter.defaultValue));
  };
  const displayValue = (parameter: PluginParameterDescriptor, normalized: number) => {
    const value = parameter.minimum + normalized * (parameter.maximum - parameter.minimum);
    const formatted = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return parameter.unit ? `${formatted} ${parameter.unit}` : formatted;
  };
  const updateParameter = (parameter: PluginParameterDescriptor, value: number) => {
    if (!props.canWrite || parameter.readOnly) return;
    const parameterId = externalAutomationParameterId(props.processor.instanceId, parameter.id);
    props.onManualAutomationOverride?.(parameterId, props.processor.instanceId);
    const normalized = Math.min(1, Math.max(0, value));
    void props.enqueueParameter({
      instanceId: props.processor.instanceId,
      id: parameter.id,
      value: normalized,
    });
    props.onParameterChange(parameter.id, normalized);
  };
  return (
    <Show when={visibleParameters().length > 0}>
      <div class="border-t border-border pt-2">
        <button
          type="button"
          class="mb-2 text-xs font-medium text-foreground hover:text-cyan-300"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded() ? "Hide" : "Show"} parameters ({visibleParameters().length})
        </button>
        <Show when={expanded()}>
          <div class="grid min-w-72 grid-cols-1 gap-2">
            <For each={visibleParameters()}>
              {(parameter) => {
                const parameterId = externalAutomationParameterId(props.processor.instanceId, parameter.id);
                const targetKey = automationTargetKey(
                  props.targetId === "master"
                    ? { kind: "master", effectInstanceId: props.processor.instanceId }
                    : { kind: "track", trackId: props.targetId, effectInstanceId: props.processor.instanceId },
                  parameterId,
                );
                const evaluated = () => props.evaluatedValuesByTargetKey?.get(targetKey);
                const value = () => evaluated() ?? normalizedValue(parameter);
                return (
                  <div class="grid grid-cols-[minmax(8rem,1fr)_minmax(7rem,1fr)_auto] items-center gap-2">
                    <div class="min-w-0">
                      <div class="truncate text-foreground">{parameter.title}</div>
                      <div class="truncate text-[10px] text-muted-foreground">
                        {displayValue(parameter, value())}
                        <Show when={props.automationRanges?.has(parameterId)}>
                          <span class="ml-1 text-cyan-300">Auto</span>
                        </Show>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step={parameter.stepCount > 0 ? 1 / parameter.stepCount : 0.01}
                      value={value()}
                      disabled={!props.canWrite || parameter.readOnly}
                      class="accent-cyan-400 disabled:opacity-50"
                      onInput={(event) => updateParameter(parameter, Number(event.currentTarget.value))}
                    />
                    <button
                      type="button"
                      class="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!props.canWrite}
                      onClick={() => props.onSelectAutomationParameter?.(parameterId, props.processor.instanceId)}
                      title="Show this parameter in an automation lane"
                    >
                      Auto
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export type ExternalPluginCardProps = {
  projectId?: string;
  processor: ExternalProcessor;
  enqueueParameter: NativeVstParameterQueue["enqueue"];
  editorAnchor?: () => { x: number; y: number } | undefined;
  canWrite: boolean;
  targetId: Track["id"] | "master";
  automationRanges?: ReadonlyMap<string, { min: number; max: number }>;
  evaluatedValuesByTargetKey?: ReadonlyMap<string, number>;
  onSelectAutomationParameter?: (parameterId: string, effectInstanceId: string) => void;
  onManualAutomationOverride?: (parameterId: string, effectInstanceId: string) => void;
  autoOpen?: boolean;
  onAutoOpenHandled?: (instanceId: string) => void;
  onRemove: () => void;
  onBypassChange: (bypassed: boolean) => void;
  onParameterChange: (parameterId: number, value: number) => void;
};

export const ExternalPluginCard: Component<ExternalPluginCardProps> = (props) => {
  const sanitizeNativeVst3DiagnosticError = (cause: unknown) => {
    const message = cause instanceof Error
      ? cause.message
      : "The native VST3 editor session could not be started.";
    return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256);
  };
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editorMessage, setEditorMessage] = createSignal<string>();
  const [liveEditorSupported, setLiveEditorSupported] = createSignal<boolean>();
  const [autoOpenStarted, setAutoOpenStarted] = createSignal(false);
  let autoOpenFailed = false;
  let editorInstanceId: string | undefined;
  const editorBridgeAvailable = () => Boolean(window.dawDesktop?.audioHost?.session.editor);
  const editorAvailable = () => nativeEditorCommandAvailable(
    editorBridgeAvailable(),
    props.processor.manifest.supportsEditor,
    liveEditorSupported(),
  );
  createEffect(() => {
    const instanceId = props.processor.instanceId;
    if (!instanceId || instanceId === editorInstanceId) return;
    editorInstanceId = instanceId;
    setAutoOpenStarted(false);
    autoOpenFailed = false;
    setEditorOpen(false);
    setEditorMessage();
    setLiveEditorSupported();
  });
  createEffect(() => {
    const instanceId = props.processor.instanceId;
    const projectId = props.projectId;
    const subscribe = window.dawDesktop?.audioHost?.onVstEditorState;
    if (!subscribe || !projectId) return;
    const unsubscribe = subscribe((state) => {
      if (state.projectId === projectId && state.instanceId === instanceId) setEditorOpen(state.open);
    });
    onCleanup(unsubscribe);
  });
  const updateBypass = (bypassed: boolean) => {
    if (!props.canWrite) return;
    props.onBypassChange(bypassed);
  };
  const editor = async (command: "open" | "close" | "focus"): Promise<boolean> => {
    const bridge = window.dawDesktop?.audioHost;
    if (!bridge || !editorAvailable() || !props.projectId) return false;
    try {
      let serializedPlan: string | undefined;
      if (command !== "close") {
        const compilation = compileNativeExternalEditorPlan({
          processor: props.processor,
          targetId: props.targetId,
        });
        if (!compilation.supported) {
          setEditorMessage(compilation.reasons.join(" "));
          return false;
        }
        serializedPlan = encodeNativeExternalAttachmentPlan(compilation.plan);
      }
      const result = await bridge.session.editor({
        projectId: props.projectId,
        instanceId: props.processor.instanceId,
        command,
        serializedPlan,
        anchor: command === "open" || command === "focus" ? props.editorAnchor?.() : undefined,
      });
      if (!result.ok) {
        setEditorMessage(result.error);
        return false;
      }
      setLiveEditorSupported(result.status.supported);
      setEditorOpen(result.status.open);
      if (!result.status.success) {
        if (result.status.supported) setEditorMessage("The native editor command was rejected.");
        return false;
      }
      setEditorMessage();
      return true;
    } catch (error) {
      if (command === "open" && props.autoOpen) {
        console.error("[native-vst3] editor auto-open caught error", {
          error: sanitizeNativeVst3DiagnosticError(error),
        });
      }
      setEditorMessage("The native VST editor session could not be started.");
      return false;
    }
  };
  createEffect(() => {
    if (!props.autoOpen) {
      autoOpenFailed = false;
      return;
    }
    const available = nativeEditorCommandAvailable(
      editorBridgeAvailable(),
      props.processor.manifest.supportsEditor,
      liveEditorSupported(),
    );
    if (autoOpenStarted() || autoOpenFailed || !available) return;
    setAutoOpenStarted(true);
    void editor("open").then((opened) => {
      if (opened) {
        // The insertion request is consumed only after the native session
        // confirms that the editor is open.
        untrack(() => props.onAutoOpenHandled?.(props.processor.instanceId));
        return;
      }
      autoOpenFailed = true;
      setAutoOpenStarted(false);
      console.error("[native-vst3] editor auto-open result failure", { opened });
    });
  });
  return (
    <EffectShell
      title={props.processor.manifest.identity.name}
      typeLabel={`${props.processor.manifest.identity.vendor} · VST3`}
      enabled={!props.processor.bypassed}
      onToggleEnabled={(enabled) => updateBypass(!enabled)}
      disabled={!props.canWrite}
      onPointerDown={(event) => {
        if (
          event.button !== 0
          || !event.isPrimary
          || isDeviceHeaderTarget(event.target)
          || isDeviceInteractiveTarget(event.target)
          || !editorOpen()
        ) return;
        void editor("focus");
      }}
      actionsBeforeReset={(
        <>
          <Show when={editorAvailable()}>
            <button
              type="button"
              class="border-r border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!props.canWrite}
              onClick={() => void editor("open")}
            >
              Open UI
            </button>
            <Show when={editorOpen()}>
              <button
                type="button"
                class="border-r border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!props.canWrite}
                onClick={() => void editor("close")}
              >
                Close UI
              </button>
            </Show>
          </Show>
          <button
            type="button"
            class="border-r border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!props.canWrite}
            onClick={props.onRemove}
          >
            Delete
          </button>
        </>
      )}
    >
      <div class="flex min-w-52 flex-1 flex-col gap-2 p-3 text-xs">
        <div class="font-medium text-foreground">{externalProcessorStatusLabel(props.processor)}</div>
        <ExternalPluginParameters
          processor={props.processor}
          enqueueParameter={props.enqueueParameter}
          targetId={props.targetId}
          canWrite={props.canWrite}
          automationRanges={props.automationRanges}
          evaluatedValuesByTargetKey={props.evaluatedValuesByTargetKey}
          onSelectAutomationParameter={props.onSelectAutomationParameter}
          onManualAutomationOverride={props.onManualAutomationOverride}
          onParameterChange={props.onParameterChange}
        />
        <div class="text-muted-foreground">
          {nativeEditorAvailabilityMessage({
            bridgeAvailable: editorBridgeAvailable(),
            preflightSupportsEditor: props.processor.manifest.supportsEditor,
            liveSupportsEditor: liveEditorSupported(),
          })}
        </div>
        <Show when={editorMessage()}>
          {(message) => <div class="text-amber-300">{message()}</div>}
        </Show>
        <p class="leading-5 text-muted-foreground">
          {props.processor.health.reason ?? (
            props.processor.bypassed
              ? "This plug-in is bypassed and is not processing audio."
              : "This plug-in is active on the native graph; browser playback remains unsupported."
          )}
        </p>
      </div>
    </EffectShell>
  );
};

export { nativeEditorAnchorFromElement };
