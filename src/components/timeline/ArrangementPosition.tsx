import { For, createSignal, type Component } from "solid-js";
import { useSteppedValueControl } from "~/hooks/useSteppedValueControl";
import {
  arrangementPositionFields,
  parsePositionDraft,
  positionFieldMax,
  timeAfterFieldChange,
  type PositionField,
} from "~/lib/arrangement-position";

const fieldLabels: Record<PositionField, string> = {
  bar: "bars",
  beat: "beats",
  sixteenth: "sixteenths",
};

// A digit field: drag, arrow keys and typed digits (Enter commits, Escape or blur discards) all locate the playhead.
const PositionFieldControl: Component<{
  field: PositionField;
  playheadSec: number;
  bpm: number;
  onLocate: (sec: number) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal<string | null>(null);
  const value = () => arrangementPositionFields(props.playheadSec, props.bpm)[props.field];

  const control = useSteppedValueControl({
    value,
    min: () => 1,
    max: () => positionFieldMax[props.field],
    step: () => 1,
    disabled: () => false,
    onValueChange: (next) => props.onLocate(timeAfterFieldChange(props.playheadSec, props.bpm, props.field, next)),
    // 0.25 value per pixel dragged up: about four pixels per step.
    valueFromDrag: ({ startValue, startPosition, currentPosition, fine }) =>
      startValue + (startPosition.y - currentPosition.y) * (fine ? 0.05 : 0.25),
  });

  const commitDraft = (text: string) => {
    const parsed = parsePositionDraft(text);

    if (parsed !== null) control.commitValue(parsed);
  };

  return (
    <span
      role="spinbutton"
      tabindex="0"
      aria-label={`Arrangement position ${fieldLabels[props.field]}`}
      aria-valuenow={value()}
      aria-valuemin={1}
      aria-valuemax={positionFieldMax[props.field]}
      class="min-w-[1.25ch] cursor-ns-resize px-0.5 text-center tabular-nums text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      onPointerDown={(event) => {
        event.currentTarget.focus();
        control.onPointerDown(event);
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;

        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          setDraft((current) => (current ?? "") + event.key);
        } else if (event.key === "Backspace" && draft() !== null) {
          event.preventDefault();
          setDraft((current) => current?.slice(0, -1) ?? null);
        } else if (event.key === "Enter" && draft() !== null) {
          event.preventDefault();
          commitDraft(draft() ?? "");
          setDraft(null);
        } else if (event.key === "Escape" && draft() !== null) {
          event.preventDefault();
          setDraft(null);
        } else {
          control.handleKeyDown(event);
        }
      }}
      onKeyUp={control.handleKeyUp}
      onBlur={() => {
        setDraft(null);
        control.handleBlur();
      }}
    >
      {draft() ?? control.visualValue()}
    </span>
  );
};

const fields: PositionField[] = ["bar", "beat", "sixteenth"];

// Ableton's Arrangement Position: bars.beats.sixteenths fields left of the transport buttons.
const ArrangementPosition: Component<{
  playheadSec: number;
  bpm: number;
  onLocate: (sec: number) => void;
}> = (props) => (
  <div role="group" aria-label="Arrangement position" class="flex items-center border border-border bg-timeline-surface px-1 py-1 text-xs text-muted-foreground">
    <For each={fields}>
      {(field, index) => (
        <>
          {index() > 0 && <span aria-hidden="true">.</span>}
          <PositionFieldControl
            field={field}
            playheadSec={props.playheadSec}
            bpm={props.bpm}
            onLocate={props.onLocate}
          />
        </>
      )}
    </For>
  </div>
);

export default ArrangementPosition;
