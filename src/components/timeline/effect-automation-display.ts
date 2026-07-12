import { parseEqBandParameterId } from "@daw-browser/shared";

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const objectRecord = (value: unknown): Record<string, unknown> | undefined => (
  isObjectRecord(value) ? value : undefined
);

const updateAutomationPath = (
  value: unknown,
  path: readonly string[],
  nextValue: number,
): unknown => {
  const [key, ...rest] = path;
  if (!key) return nextValue;
  const record = objectRecord(value) ?? {};
  return {
    ...record,
    [key]: rest.length > 0
      ? updateAutomationPath(record[key], rest, nextValue)
      : nextValue,
  };
};

const updateEqBandValue = (
  value: unknown,
  bandId: string,
  property: string,
  nextValue: number,
): unknown => {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record.bands)) return value;
  let field = "q";
  if (property === "frequencyHz") field = "frequency";
  if (property === "gainDb") field = "gainDb";
  return {
    ...record,
    bands: record.bands.map((band) => {
      const bandRecord = objectRecord(band);
      return bandRecord?.id === bandId
        ? { ...bandRecord, [field]: nextValue }
        : band;
    }),
  };
};

export const overlayEffectAutomationValue = (
  value: unknown,
  parameterId: string,
  nextValue: number,
): unknown => {
  const eq = parseEqBandParameterId(parameterId);
  const update = eq
    ? (input: unknown) => updateEqBandValue(input, eq.bandId, eq.property, nextValue)
    : (input: unknown) => updateAutomationPath(input, parameterId.split(".").slice(1), nextValue);
  const record = objectRecord(value);
  if (!record || !("state" in record)) return update(value);
  return { ...record, state: update(record.state) };
};
