export const REORDER_ACTIVATION_THRESHOLD_PX = 4;

const interactiveSelector = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[data-device-interactive='true']",
].join(",");

export const isDeviceInteractiveTarget = (target: EventTarget | null): boolean => (
  globalThis.Element !== undefined
  && target instanceof globalThis.Element
  && target.closest(interactiveSelector) !== null
);

export const isDeviceHeaderTarget = (target: EventTarget | null): boolean => (
  globalThis.Element !== undefined
  && target instanceof globalThis.Element
  && target.closest('[data-effect-shell-header="true"]') !== null
);
