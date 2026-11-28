import { expect, test } from "bun:test";
import {
  AUDIO_EFFECT_KINDS,
  audioEffectKindsWithOperation,
} from "@daw-browser/shared";
import { literalUnion } from "./effectKindValidators";

const literals = (validator: ReturnType<typeof literalUnion>) => validator.members.map((member) => member.value);

test("a literal union accepts its values in order and nothing else", () => {
  const validator = literalUnion(["a", "b"]);

  expect(literals(validator)).toEqual(["a", "b"]);
  expect(validator.kind).toBe("union");
});

test("the device kind lists stay what the validators were written as", () => {
  expect(literals(literalUnion(audioEffectKindsWithOperation("processor")))).toEqual(["utility", "gate", "limiter", "spectral"]);
  expect(literals(literalUnion(audioEffectKindsWithOperation("modulation")))).toEqual([
    "autofilter", "lofi", "chorus", "flanger", "phaser", "tremolo", "autopan", "ensemble", "spectrum",
  ]);
  expect(literals(literalUnion(AUDIO_EFFECT_KINDS))).toEqual([
    "utility", "eq", "autofilter", "gate", "compressor", "saturator", "limiter", "lofi", "chorus", "flanger",
    "phaser", "tremolo", "autopan", "ensemble", "delay", "reverb", "spectral", "spectrum",
  ]);
});
