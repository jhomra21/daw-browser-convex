import { expect, test } from "bun:test";
import { processorEditKindId } from "./processor-edit-semantics";

test("processor edit IDs match the previous renderer switch", () => {
  const previousIds = {
    utility: 1,
    saturator: 2,
    eq: 3,
    chorus: 4,
    flanger: 5,
    phaser: 6,
    tremolo: 7,
    autopan: 8,
    ensemble: 9,
    gate: 10,
    compressor: 11,
    limiter: 12,
    delay: 13,
    reverb: 14,
    spectral: 15,
    autofilter: 16,
    lofi: 17,
    instrument: 18,
  } satisfies Record<string, number>;

  for (const [effect, id] of Object.entries(previousIds)) {
    expect(processorEditKindId(effect)).toBe(id);
    expect(processorEditKindId(`master-${effect}`)).toBe(id);
  }
  expect(processorEditKindId("unknown")).toBeUndefined();
});
