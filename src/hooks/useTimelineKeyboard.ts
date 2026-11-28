import { onSettled, onCleanup, type Accessor } from "solid-js";

import {
  isLocalTimelineKeyboardTarget,
  keyboardTargetOwner,
} from "~/lib/keyboard-event-target";
import type { ShortcutChord, ShortcutResolutionContext } from "~/lib/extensions";
import { isMacDesktop } from "~/lib/runtime";

// On desktop macOS the Edit menu owns bare Cmd+Z, Cmd+Shift+Z and Cmd+D as key equivalents.
type KeyboardHandlers = {
  enabled: Accessor<boolean>;
  onSpace: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => boolean;
  onPaste: () => boolean;
  onAddAudioTrack: () => void;
  onAddReturnTrack: () => void;
  onAddGroupTrack: () => void;
  onGroupSelectedTracks: () => void;
  onUngroupSelectedTrack: () => void;
  onAddInstrumentTrack: () => void;
  onOpenExport: () => void;
  onToggleFollow: () => void;
  executeExtensionShortcut: (
    chord: ShortcutChord,
    context: ShortcutResolutionContext,
  ) => boolean;
  onUndo: () => void;
  onRedo: () => void;
};

type TimelineKeyboardEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "key"
  | "metaKey"
  | "preventDefault"
  | "shiftKey"
  | "stopPropagation"
  | "target"
> & { composedPath: () => EventTarget[] };

type ShortcutContext = {
  e: TimelineKeyboardEvent;
  path: EventTarget[];
  handlers: KeyboardHandlers;
  // On desktop macOS the native menu's key equivalent fires first, so handling its keys here would double-fire.
  menuOwnsCommandKey: boolean;
};

type TimelineShortcut = {
  id: string;
  matches: (e: TimelineKeyboardEvent) => boolean;
  run: (context: ShortcutContext) => void;
};

const keyIs = (e: TimelineKeyboardEvent, letter: string) => e.key === letter || e.key === letter.toUpperCase();
const mod = (e: TimelineKeyboardEvent) => e.ctrlKey || e.metaKey;
const bareShift = (e: TimelineKeyboardEvent) => !e.ctrlKey && !e.metaKey && e.shiftKey;

const consume = (e: TimelineKeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

// The first matching shortcut owns the event, whether or not it acts on it. Order is part of the contract.
const timelineShortcuts: readonly TimelineShortcut[] = [
  {
    id: "toggle-follow",
    matches: (e) =>
      e.shiftKey &&
      ((e.ctrlKey && !e.metaKey && !e.altKey) || (e.altKey && !e.ctrlKey && !e.metaKey)) &&
      keyIs(e, "f"),
    run: ({ e, handlers }) => {
      if (e.altKey && isMacDesktop()) return;
      consume(e);
      handlers.onToggleFollow();
    },
  },
  {
    id: "group-tracks",
    matches: (e) => mod(e) && !e.altKey && keyIs(e, "g"),
    run: ({ e, handlers }) => {
      consume(e);

      if (e.shiftKey) handlers.onUngroupSelectedTrack();
      else handlers.onGroupSelectedTracks();
    },
  },
  {
    id: "extension-ctrl-alt-b",
    matches: (e) => mod(e) && e.altKey && !e.shiftKey && keyIs(e, "b"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.executeExtensionShortcut(
        { mod: true, alt: true, shift: false, key: e.key },
        { editableTarget: false },
      );
    },
  },
  {
    id: "add-instrument-track",
    matches: (e) => mod(e) && e.shiftKey && keyIs(e, "t"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onAddInstrumentTrack();
    },
  },
  {
    id: "add-audio-track",
    matches: (e) => bareShift(e) && keyIs(e, "t"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onAddAudioTrack();
    },
  },
  {
    id: "add-return-track",
    matches: (e) => bareShift(e) && keyIs(e, "r"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onAddReturnTrack();
    },
  },
  {
    id: "add-group-track",
    matches: (e) => bareShift(e) && keyIs(e, "g"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onAddGroupTrack();
    },
  },
  {
    id: "duplicate",
    matches: (e) => mod(e) && keyIs(e, "d"),
    run: ({ e, path, handlers, menuOwnsCommandKey }) => {
      if (path.some(isLocalTimelineKeyboardTarget)) return;

      if (menuOwnsCommandKey) return;
      consume(e);
      handlers.onDuplicate();
    },
  },
  {
    id: "copy",
    matches: (e) => mod(e) && keyIs(e, "c"),
    run: ({ e, handlers }) => {
      if (handlers.onCopy()) consume(e);
    },
  },
  {
    id: "paste",
    matches: (e) => mod(e) && keyIs(e, "v"),
    run: ({ e, handlers }) => {
      if (handlers.onPaste()) consume(e);
    },
  },
  {
    id: "undo-redo",
    matches: (e) => mod(e) && keyIs(e, "z"),
    run: ({ e, handlers, menuOwnsCommandKey }) => {
      if (menuOwnsCommandKey) return;
      consume(e);

      if (e.shiftKey) handlers.onRedo();
      else handlers.onUndo();
    },
  },
  {
    id: "redo",
    matches: (e) => mod(e) && !e.shiftKey && keyIs(e, "y"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onRedo();
    },
  },
  {
    id: "export-mixdown",
    matches: (e) => mod(e) && e.shiftKey && keyIs(e, "e"),
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onOpenExport();
    },
  },
  {
    id: "play-pause",
    matches: (e) => e.code === "Space",
    run: ({ e, handlers }) => {
      consume(e);
      handlers.onSpace();
    },
  },
  {
    id: "delete",
    matches: (e) => e.key === "Delete" || e.key === "Backspace",
    run: ({ e, path, handlers }) => {
      if (path.some(isLocalTimelineKeyboardTarget)) return;
      consume(e);
      handlers.onDelete();
    },
  },
];

export const createTimelineKeyboardHandler = (handlers: KeyboardHandlers) => (
  e: TimelineKeyboardEvent,
) => {
  if (!handlers.enabled()) return;

  // The composed path includes editable nodes inside open shadow roots and
  // actual portal ancestry even though this listener runs in window capture.
  const path = e.composedPath();

  if (keyboardTargetOwner(path)) return;

  const shortcut = timelineShortcuts.find((candidate) => candidate.matches(e));

  shortcut?.run({
    e,
    path,
    handlers,
    menuOwnsCommandKey: e.metaKey && !e.ctrlKey && !e.altKey && isMacDesktop(),
  });
};

export function useTimelineKeyboard(handlers: KeyboardHandlers) {
  const captureOptions: AddEventListenerOptions = { capture: true };
  const onKeyDown = createTimelineKeyboardHandler(handlers);
  onSettled(() => {
    window.addEventListener("keydown", onKeyDown, captureOptions);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, captureOptions);
  });
}
