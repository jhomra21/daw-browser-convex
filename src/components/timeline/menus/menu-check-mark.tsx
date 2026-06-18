import { type Component } from "solid-js";

export const MenuCheckMark: Component<{ checked: boolean }> = (props) => (
  <span class="inline-flex w-4 shrink-0 justify-center text-green-400">
    {props.checked ? "✓" : ""}
  </span>
);
