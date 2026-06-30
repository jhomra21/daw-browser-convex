import { onMount, onCleanup, type Accessor } from "solid-js";

import { isEditableKeyboardTarget } from "~/lib/keyboard-event-target";

type KeyboardHandlers = {
  enabled: Accessor<boolean>;
  onSpace: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onAddAudioTrack: () => void;
  onAddReturnTrack: () => void;
  onAddGroupTrack: () => void;
  onAddInstrumentTrack: () => void;
  onOpenExport: () => void;
  onToggleBrowser: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

export function useTimelineKeyboard(handlers: KeyboardHandlers) {
  const captureOptions = { capture: true } as const;

  function onKeyDown(e: KeyboardEvent) {
    if (!handlers.enabled()) return;

    if (isEditableKeyboardTarget(e.target)) return;


    if (
      (e.ctrlKey || e.metaKey) &&
      e.altKey &&
      !e.shiftKey &&
      (e.key === "b" || e.key === "B")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onToggleBrowser();
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
      e.preventDefault();
      e.stopPropagation();
      handlers.onDuplicate();
      return;
    }

    // Undo: Ctrl/Cmd + Z
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      (e.key === "z" || e.key === "Z")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onUndo();
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
      e.preventDefault();
      e.stopPropagation();
      handlers.onDelete();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown, captureOptions);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, captureOptions);
  });
}
