import { type Component, createSignal } from "solid-js";
import {
  DEFAULT_MIXER_VOLUME,
  formatMixerVolumeDb,
  mixerSliderPositionToVolume,
  mixerVolumeToSliderPosition,
  MIXER_VOLUME_SLIDER_STEP,
  normalizeMixerVolume,
} from "@daw-browser/shared";
import { cn } from "~/lib/utils";

type ActivePointer = {
  pointerId: number;
  startValue: number;
  value: number;
};

export type MixerVolumeSliderProps = {
  value: number;
  disabled: boolean;
  automated: boolean;
  automationRange?: { min: number; max: number };
  ariaLabel: string;
  title: string;
  onSelect: () => void;
  onPreview: (value: number) => void;
  onCommit: (value: number, previousValue: number) => void;
  onCancel: (value: number) => void;
  onReset: () => void;
};

const MixerVolumeSlider: Component<MixerVolumeSliderProps> = (props) => {
  const [activePointer, setActivePointer] = createSignal<ActivePointer>();
  const [keyboardStartValue, setKeyboardStartValue] = createSignal<
    number | undefined
  >();

  const currentValue = () =>
    activePointer()?.value ??
    mixerSliderPositionToVolume(mixerVolumeToSliderPosition(props.value));
  const currentPosition = () => mixerVolumeToSliderPosition(currentValue());
  const automationStart = () =>
    mixerVolumeToSliderPosition(props.automationRange?.min ?? 0);
  const automationEnd = () =>
    mixerVolumeToSliderPosition(props.automationRange?.max ?? 0);

  const previewFromPosition = (position: number) => {
    const value = mixerSliderPositionToVolume(position);
    const active = activePointer();
    if (active) {
      if (active.value === value) return;
      setActivePointer({ ...active, value });
    }
    props.onPreview(value);
  };

  const updateFromPointer = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    previewFromPosition((clientX - rect.left) / width);
  };

  const releasePointer = (input: HTMLInputElement, pointerId: number) => {
    if (input.hasPointerCapture(pointerId)) input.releasePointerCapture(pointerId);
  };

  const finishPointer = (input: HTMLInputElement, pointerId: number) => {
    const active = activePointer();
    if (!active || active.pointerId !== pointerId) return;
    setActivePointer();
    releasePointer(input, pointerId);
    props.onCommit(active.value, active.startValue);
  };

  const cancelPointer = (input: HTMLInputElement, pointerId: number) => {
    const active = activePointer();
    if (!active || active.pointerId !== pointerId) return;
    setActivePointer();
    releasePointer(input, pointerId);
    props.onCancel(active.startValue);
  };

  return (
    <div class="relative flex h-5 min-w-0 items-center">
      <input
        type="range"
        min="0"
        max="1"
        step={MIXER_VOLUME_SLIDER_STEP}
        value={currentPosition()}
        disabled={props.disabled}
        style={{
          "--mixer-volume-percent": `${currentPosition() * 100}%`,
          "--mixer-volume-automation-start": `${automationStart() * 100}%`,
          "--mixer-volume-automation-end": `${automationEnd() * 100}%`,
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (props.disabled) return;
          props.onSelect();
          event.preventDefault();
          const startValue = normalizeMixerVolume(currentValue());
          setKeyboardStartValue();
          setActivePointer({
            pointerId: event.pointerId,
            startValue,
            value: startValue,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event.currentTarget, event.clientX);
        }}
        onPointerMove={(event) => {
          const active = activePointer();
          if (!active || active.pointerId !== event.pointerId) return;
          event.stopPropagation();
          updateFromPointer(event.currentTarget, event.clientX);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          finishPointer(event.currentTarget, event.pointerId);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          cancelPointer(event.currentTarget, event.pointerId);
        }}
        onLostPointerCapture={(event) => {
          cancelPointer(event.currentTarget, event.pointerId);
        }}
        onInput={(event) => {
          event.stopPropagation();
          if (props.disabled) return;
          const value = mixerSliderPositionToVolume(
            Number.parseFloat(event.currentTarget.value),
          );
          const active = activePointer();
          if (active) {
            previewFromPosition(Number.parseFloat(event.currentTarget.value));
            return;
          }
          if (keyboardStartValue() === undefined)
            setKeyboardStartValue(normalizeMixerVolume(props.value));
          props.onPreview(value);
        }}
        onChange={(event) => {
          event.stopPropagation();
          const startValue = keyboardStartValue();
          if (props.disabled || startValue === undefined) return;
          setKeyboardStartValue();
          props.onCommit(
            mixerSliderPositionToVolume(
              Number.parseFloat(event.currentTarget.value),
            ),
            startValue,
          );
        }}
        onDblClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          if (props.disabled) return;
          setActivePointer();
          setKeyboardStartValue();
          props.onSelect();
          props.onPreview(DEFAULT_MIXER_VOLUME);
          props.onReset();
        }}
        class={cn(
          "mixer-volume-slider w-full cursor-pointer",
          props.automated && "mixer-volume-slider-automated",
          props.disabled && "cursor-not-allowed opacity-60",
        )}
        title={props.title}
        aria-label={props.ariaLabel}
        aria-valuetext={formatMixerVolumeDb(currentValue())}
      />
      <output
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-xs font-semibold tabular-nums text-foreground"
        aria-hidden="true"
      >
        <span class="mixer-volume-value">
          {formatMixerVolumeDb(currentValue())}
        </span>
      </output>
    </div>
  );
};

export default MixerVolumeSlider;
