import { Show, type Component } from "solid-js";

// A neutral title-bar marker for a routing the native engine does not support yet (E6). It sits on the element the
// routing belongs to and is no failure: playback continues unchanged.
const NativeLimitNotice: Component<{ reason: string | undefined }> = (props) => (
  <Show when={props.reason}>
    {(reason) => (
      <span
        role="status"
        class="shrink-0 text-[10px] text-muted-foreground"
        title={`${reason()} Playback continues unchanged.`}
      >
        Not supported yet
      </span>
    )}
  </Show>
);

export default NativeLimitNotice;
