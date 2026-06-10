type KeyboardShortcut = {
  keys: string;
  label: string;
  section: string;
};

export const timelineKeyboardShortcuts: readonly KeyboardShortcut[] = [
  { section: "Transport", keys: "Space", label: "Play or pause" },
  { section: "Edit", keys: "Delete / Backspace", label: "Delete selection" },
  { section: "Edit", keys: "Ctrl/Cmd + D", label: "Duplicate selection" },
  { section: "Edit", keys: "Ctrl/Cmd + Z", label: "Undo" },
  { section: "Edit", keys: "Ctrl/Cmd + Y", label: "Redo" },
  { section: "Tracks", keys: "Shift + T", label: "Add audio track" },
  { section: "Tracks", keys: "Ctrl/Cmd + Shift + T", label: "Add instrument track" },
  { section: "Tracks", keys: "Shift + R", label: "Add return track" },
  { section: "Tracks", keys: "Shift + G", label: "Add group track" },
  { section: "Export", keys: "Ctrl/Cmd + Shift + E", label: "Open export mixdown" },
];
