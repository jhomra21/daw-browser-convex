import { onMount, onCleanup, type Accessor } from "solid-js";

import {
  isLocalTimelineKeyboardTarget,
  keyboardTargetOwner,
} from "~/lib/keyboard-event-target";
import type { ShortcutChord, ShortcutResolutionContext } from "~/lib/extensions";

// On desktop macOS the Edit menu owns bare Cmd+Z, Cmd+Shift+Z and Cmd+D as key equivalents.
const isDesktopMacApp = () => Boolean(globalThis.window?.dawDesktop) && /Macintosh/.test(navigator.userAgent);

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

export const createTimelineKeyboardHandler = (handlers: KeyboardHandlers) => (
  e: TimelineKeyboardEvent,
) => {
    if (!handlers.enabled()) return;

    // The composed path includes editable nodes inside open shadow roots and
    // actual portal ancestry even though this listener runs in window capture.
    const path = e.composedPath();
    if (keyboardTargetOwner(path)) return;

    // Left to the native menu on desktop macOS: its key equivalent fires first, so handling these here would double-fire.
    const menuOwnsCommandKey = e.metaKey && !e.ctrlKey && !e.altKey && isDesktopMacApp();

    if (
      e.shiftKey &&
      ((e.ctrlKey && !e.metaKey && !e.altKey) || (e.altKey && !e.ctrlKey && !e.metaKey)) &&
      (e.key === "f" || e.key === "F")
    ) {
      if (e.altKey && isDesktopMacApp()) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.onToggleFollow();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) handlers.onUngroupSelectedTrack();
      else handlers.onGroupSelectedTracks();
      return;
    }

    if (
      (e.ctrlKey || e.metaKey) &&
      e.altKey &&
      !e.shiftKey &&
      (e.key === "b" || e.key === "B")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.executeExtensionShortcut(
        { mod: true, alt: true, shift: false, key: e.key },
        { editableTarget: false },
      );
      return;
    }
    // Add Track
    // Instrument: Ctrl/Cmd + Shift + T
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "t" || e.key === "T")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onAddInstrumentTrack();
      return;
    }
    // Audio: Shift + T (no Ctrl/Cmd)
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      e.shiftKey &&
      (e.key === "t" || e.key === "T")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onAddAudioTrack();
      return;
    }
    // Return: Shift + R (no Ctrl/Cmd)
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      e.shiftKey &&
      (e.key === "r" || e.key === "R")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onAddReturnTrack();
      return;
    }
    // Group: Shift + G (no Ctrl/Cmd)
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      e.shiftKey &&
      (e.key === "g" || e.key === "G")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onAddGroupTrack();
      return;
    }

    // Duplicate: Ctrl/Cmd + D
    if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      if (path.some(isLocalTimelineKeyboardTarget)) return;
      if (menuOwnsCommandKey) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.onDuplicate();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      if (handlers.onCopy()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
      if (handlers.onPaste()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Undo: Ctrl/Cmd + Z; redo: Ctrl/Cmd + Shift + Z
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === "z" || e.key === "Z")
    ) {
      if (menuOwnsCommandKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) handlers.onRedo();
      else handlers.onUndo();
      return;
    }
    // Redo: Ctrl/Cmd + Y
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      (e.key === "y" || e.key === "Y")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onRedo();
      return;
    }

    // Export: Ctrl/Cmd + Shift + E
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "e" || e.key === "E")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onOpenExport();
      return;
    }

    if (e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
      handlers.onSpace();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (path.some(isLocalTimelineKeyboardTarget)) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.onDelete();
    }
};

export function useTimelineKeyboard(handlers: KeyboardHandlers) {
  const captureOptions: AddEventListenerOptions = { capture: true };
  const onKeyDown = createTimelineKeyboardHandler(handlers);
  onMount(() => {
    window.addEventListener("keydown", onKeyDown, captureOptions);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, captureOptions);
  });
}
