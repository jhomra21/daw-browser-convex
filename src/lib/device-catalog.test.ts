import { describe, expect, test } from "bun:test";
import {
  AUDIO_EFFECT_ORDER,
  INSTRUMENT_CONTRACTS,
  isInstrumentKind,
  OWNED_PROCESSOR_DESCRIPTORS,
  OWNED_PROCESSOR_KINDS,
} from "@daw-browser/shared";
import {
  AUDIO_EFFECT_DEVICE_CATALOG,
  BROWSER_AUDIO_EFFECT_CATALOG,
  BROWSER_DEVICE_CATALOG,
  BROWSER_INSTRUMENT_CATALOG,
  BROWSER_MIDI_EFFECT_CATALOG,
  CONTEXT_MENU_AUDIO_EFFECT_CATALOG,
  CONTEXT_MENU_DEVICE_CATALOG,
  CONTEXT_MENU_INSTRUMENT_CATALOG,
  CONTEXT_MENU_MIDI_EFFECT_CATALOG,
  DEVICE_CATALOG,
  INSTRUMENT_DEVICE_CATALOG,
} from "./device-catalog";

const supportedInstrumentKinds = Object.keys(INSTRUMENT_CONTRACTS).filter(isInstrumentKind);

describe("device catalog completeness", () => {
  test("covers every supported runtime and persistence audio effect kind", () => {
    expect(AUDIO_EFFECT_DEVICE_CATALOG.map((entry) => entry.kind)).toEqual(AUDIO_EFFECT_ORDER);
    expect(BROWSER_AUDIO_EFFECT_CATALOG.map((entry) => entry.kind)).toEqual(AUDIO_EFFECT_ORDER);
    expect(CONTEXT_MENU_AUDIO_EFFECT_CATALOG.map((entry) => entry.kind)).toEqual(AUDIO_EFFECT_ORDER);
  });

  test("covers every supported runtime and persistence instrument kind", () => {
    expect(INSTRUMENT_DEVICE_CATALOG.map((entry) => entry.kind)).toEqual(supportedInstrumentKinds);
    expect(BROWSER_INSTRUMENT_CATALOG.map((entry) => entry.kind)).toEqual(supportedInstrumentKinds);
    expect(CONTEXT_MENU_INSTRUMENT_CATALOG.map((entry) => entry.kind)).toEqual(supportedInstrumentKinds);
  });

  test("covers owned processors without duplicating their contracts or descriptors", () => {
    for (const kind of OWNED_PROCESSOR_KINDS) {
      const entry = AUDIO_EFFECT_DEVICE_CATALOG.find((candidate) => candidate.kind === kind);
      expect(entry?.contract.kind).toBe(kind);
      expect(entry?.descriptor).toBe(OWNED_PROCESSOR_DESCRIPTORS[kind]);
    }
  });
});

describe("device catalog surface derivation", () => {
  test("derives Browser and EffectsPanel entries from the same addable catalog", () => {
    expect(BROWSER_DEVICE_CATALOG.map((entry) => entry.id)).toEqual(
      CONTEXT_MENU_DEVICE_CATALOG.map((entry) => entry.id),
    );
    expect(BROWSER_MIDI_EFFECT_CATALOG.map((entry) => entry.payload)).toEqual(
      CONTEXT_MENU_MIDI_EFFECT_CATALOG.map((entry) => entry.payload),
    );
    expect(BROWSER_DEVICE_CATALOG.every((entry) => (
      entry.capabilities.addable
      && entry.capabilities.browser
      && entry.capabilities.contextMenu
      && entry.capabilities.drag
    ))).toBe(true);
  });

  test("keeps catalog identities unique", () => {
    const ids = DEVICE_CATALOG.map((entry) => entry.id);
    const kinds = DEVICE_CATALOG.map((entry) => `${entry.category}:${entry.kind}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
