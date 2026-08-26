import { expect, test } from "bun:test";
import { createTimelineKeyboardHandler } from "./useTimelineKeyboard";

class TestElement extends EventTarget {
  readonly tagName: string;
  readonly isContentEditable = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }

  closest(): null {
    return null;
  }
}

type TestKeyboardEvent = Readonly<{
  target: EventTarget;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  stopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}>;

const createKeyboardEvent = (
  target: TestElement,
  init: {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  },
): TestKeyboardEvent => {
  let defaultPrevented = false;
  let stopped = false;
  return {
    target,
    key: init.key,
    code: init.code ?? "",
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get stopped() {
      return stopped;
    },
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  };
};

test("routes only the exact browser chord and preserves editable-target exclusion", () => {
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  Reflect.set(globalThis, "Element", TestElement);
  Reflect.set(globalThis, "HTMLElement", TestElement);

  const calls: Array<{ chord: string; editableTarget: boolean }> = [];
  try {
    const onKeyDown = createTimelineKeyboardHandler({
      enabled: () => true,
      onSpace: () => {},
      onDelete: () => {},
      onDuplicate: () => {},
      onCopy: () => false,
      onPaste: () => false,
      onAddAudioTrack: () => {},
      onAddReturnTrack: () => {},
      onAddGroupTrack: () => {},
      onGroupSelectedTracks: () => {},
      onUngroupSelectedTrack: () => {},
      onAddInstrumentTrack: () => {},
      onOpenExport: () => {},
      executeExtensionShortcut: (chord, context) => {
        calls.push({
          chord: `${chord.mod}:${chord.alt}:${chord.shift}:${chord.key ?? chord.code}`,
          editableTarget: context.editableTarget,
        });
        return true;
      },
      onUndo: () => {},
      onRedo: () => {},
    });

    const event = createKeyboardEvent(new TestElement("DIV"), {
      key: "B",
      ctrlKey: true,
      altKey: true,
    });
    onKeyDown(event);
    expect(calls).toEqual([{ chord: "true:true:false:B", editableTarget: false }]);
    expect(event.defaultPrevented).toBeTrue();
    expect(event.stopped).toBeTrue();

    const editable = new TestElement("INPUT");
    onKeyDown(createKeyboardEvent(editable, {
      key: "b",
      metaKey: true,
      altKey: true,
    }));
    expect(calls).toHaveLength(1);

    onKeyDown(createKeyboardEvent(new TestElement("DIV"), {
      key: "b",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    }));
    expect(calls).toHaveLength(1);
  } finally {
    Reflect.set(globalThis, "Element", previousElement);
    Reflect.set(globalThis, "HTMLElement", previousHTMLElement);
  }
});
