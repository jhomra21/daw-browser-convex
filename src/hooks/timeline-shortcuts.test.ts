import { expect, test } from "bun:test";
import { createTimelineKeyboardHandler } from "./useTimelineKeyboard";

class TestElement extends EventTarget {
  readonly isContentEditable = false;

  constructor(
    readonly tagName = "DIV",
    private readonly isClip = false,
  ) {
    super();
  }

  closest(): null {
    return null;
  }

  matches(selector: string) {
    return this.isClip && selector === '[data-timeline-clip="1"]';
  }
}

type Chord = { key?: string; code?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean };

type PressOptions = { copyHandled?: boolean; target?: TestElement; clipsHandled?: boolean };

const press = (chord: Chord, options: PressOptions = {}) => {
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  Reflect.set(globalThis, "Element", TestElement);
  Reflect.set(globalThis, "HTMLElement", TestElement);
  const calls: string[] = [];

  const record = (name: string) => () => {
    calls.push(name);
  };

  const handled = (name: string, result: boolean) => () => {
    calls.push(name);

    return result;
  };

  try {
    const target = options.target ?? new TestElement();
    let prevented = false;
    let stopped = false;
    createTimelineKeyboardHandler({
      enabled: () => true,
      onSpace: record("space"),
      onDelete: record("delete"),
      onDuplicate: record("duplicate"),
      onCopy: handled("copy", options.copyHandled ?? false),
      onPaste: handled("paste", options.copyHandled ?? false),
      onAddAudioTrack: record("add-audio"),
      onAddReturnTrack: record("add-return"),
      onAddGroupTrack: record("add-group"),
      onGroupSelectedTracks: record("group"),
      onUngroupSelectedTrack: record("ungroup"),
      onAddInstrumentTrack: record("add-instrument"),
      onOpenExport: record("export"),
      onToggleFollow: record("follow"),
      onToggleLoop: record("loop"),
      onLocateStart: record("locate-start"),
      onNudgeClips: (direction) => {
        calls.push(`nudge:${direction}`);

        return options.clipsHandled ?? false;
      },
      onNavigateClips: (axis, direction) => {
        calls.push(`navigate:${axis}:${direction}`);

        return options.clipsHandled ?? false;
      },
      executeExtensionShortcut: () => {
        calls.push("extension");

        return true;
      },
      onUndo: record("undo"),
      onRedo: record("redo"),
    })({
      target,
      composedPath: () => [target],
      key: chord.key ?? "",
      code: chord.code ?? "",
      ctrlKey: chord.ctrl ?? false,
      metaKey: chord.meta ?? false,
      altKey: chord.alt ?? false,
      shiftKey: chord.shift ?? false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });

    return { calls, prevented, stopped };
  } finally {
    Reflect.set(globalThis, "Element", previousElement);
    Reflect.set(globalThis, "HTMLElement", previousHTMLElement);
  }
};

const consumed = (call: string) => ({ calls: [call], prevented: true, stopped: true });
const ignored = { calls: [], prevented: false, stopped: false };

test("every timeline shortcut keeps its chord, handler and consumption", () => {
  expect(press({ key: "F", ctrl: true, shift: true })).toEqual(consumed("follow"));
  expect(press({ key: "f", alt: true, shift: true })).toEqual(consumed("follow"));
  expect(press({ key: "f", meta: true, shift: true })).toEqual(ignored);
  expect(press({ key: "g", ctrl: true })).toEqual(consumed("group"));
  expect(press({ key: "G", meta: true, shift: true })).toEqual(consumed("ungroup"));
  expect(press({ key: "b", ctrl: true, alt: true })).toEqual(consumed("extension"));
  expect(press({ key: "b", ctrl: true, alt: true, shift: true })).toEqual(ignored);
  expect(press({ key: "T", ctrl: true, shift: true })).toEqual(consumed("add-instrument"));
  expect(press({ key: "T", shift: true })).toEqual(consumed("add-audio"));
  expect(press({ key: "R", shift: true })).toEqual(consumed("add-return"));
  expect(press({ key: "G", shift: true })).toEqual(consumed("add-group"));
  expect(press({ key: "d", ctrl: true })).toEqual(consumed("duplicate"));
  expect(press({ key: "D", meta: true })).toEqual(consumed("duplicate"));
  expect(press({ key: "c", ctrl: true })).toEqual({ calls: ["copy"], prevented: false, stopped: false });
  expect(press({ key: "c", ctrl: true }, { copyHandled: true })).toEqual({ calls: ["copy"], prevented: true, stopped: true });
  expect(press({ key: "v", meta: true }, { copyHandled: true })).toEqual({ calls: ["paste"], prevented: true, stopped: true });
  expect(press({ key: "z", ctrl: true })).toEqual(consumed("undo"));
  expect(press({ key: "Z", ctrl: true, shift: true })).toEqual(consumed("redo"));
  expect(press({ key: "y", ctrl: true })).toEqual(consumed("redo"));
  expect(press({ key: "y", ctrl: true, shift: true })).toEqual(ignored);
  expect(press({ key: "E", ctrl: true, shift: true })).toEqual(consumed("export"));
  expect(press({ key: " ", code: "Space" })).toEqual(consumed("space"));
  expect(press({ key: "Delete" })).toEqual(consumed("delete"));
  expect(press({ key: "Backspace" })).toEqual(consumed("delete"));
  expect(press({ key: "x", ctrl: true })).toEqual(ignored);
  expect(press({ key: "t" })).toEqual(ignored);
  expect(press({ key: "t", ctrl: true, alt: true, shift: true })).toEqual(consumed("add-instrument"));
  expect(press({ key: "l", ctrl: true })).toEqual(consumed("loop"));
  expect(press({ key: "L", meta: true })).toEqual(consumed("loop"));
  expect(press({ key: "l", ctrl: true, shift: true })).toEqual(ignored);
  expect(press({ key: "l", ctrl: true, alt: true })).toEqual(ignored);
});

test("arrow and Home keys drive the arrangement only from the page or a clip", () => {
  const body = new TestElement("BODY");
  const clip = new TestElement("DIV", true);
  const control = new TestElement("DIV");

  expect(press({ key: "Home" }, { target: body })).toEqual(consumed("locate-start"));
  expect(press({ key: "Home" }, { target: clip })).toEqual(consumed("locate-start"));
  expect(press({ key: "Home" }, { target: control })).toEqual(ignored);
  expect(press({ key: "Home", shift: true }, { target: body })).toEqual(ignored);

  expect(press({ key: "ArrowRight" }, { target: clip, clipsHandled: true })).toEqual(consumed("nudge:1"));
  expect(press({ key: "ArrowLeft" }, { target: body, clipsHandled: true })).toEqual(consumed("nudge:-1"));
  expect(press({ key: "ArrowRight" }, { target: control, clipsHandled: true })).toEqual(ignored);
  expect(press({ key: "ArrowRight", shift: true }, { target: clip, clipsHandled: true })).toEqual(ignored);
  expect(press({ key: "ArrowUp" }, { target: clip, clipsHandled: true })).toEqual(ignored);
});

test("arrow keys keep their default when no clip is selected", () => {
  const clip = new TestElement("DIV", true);

  expect(press({ key: "ArrowRight" }, { target: clip })).toEqual({ calls: ["nudge:1"], prevented: false, stopped: false });
  expect(press({ key: "ArrowDown", alt: true }, { target: clip })).toEqual({ calls: ["navigate:track:1"], prevented: false, stopped: false });
});

test("Alt arrows move clip focus along the track or across tracks", () => {
  const clip = new TestElement("DIV", true);

  expect(press({ key: "ArrowLeft", alt: true }, { target: clip, clipsHandled: true })).toEqual(consumed("navigate:time:-1"));
  expect(press({ key: "ArrowRight", alt: true }, { target: clip, clipsHandled: true })).toEqual(consumed("navigate:time:1"));
  expect(press({ key: "ArrowUp", alt: true }, { target: clip, clipsHandled: true })).toEqual(consumed("navigate:track:-1"));
  expect(press({ key: "ArrowDown", alt: true }, { target: clip, clipsHandled: true })).toEqual(consumed("navigate:track:1"));
  expect(press({ key: "ArrowDown", alt: true, ctrl: true }, { target: clip, clipsHandled: true })).toEqual(ignored);
  expect(press({ key: "ArrowDown", alt: true }, { target: new TestElement("DIV"), clipsHandled: true })).toEqual(ignored);
});
