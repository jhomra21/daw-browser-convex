import {
  isJsonObject,
  parseEqBandParameterId,
  type JsonObject,
} from "@daw-browser/shared";

const updateAutomationPath = (
  value: JsonObject | undefined,
  path: readonly string[],
  nextValue: number,
): JsonObject => {
  const [key, ...rest] = path;
  if (!key) return value ?? {};
  const record = value ?? {};
  return {
    ...record,
    [key]: rest.length > 0
      ? updateAutomationPath(isJsonObject(record[key]) ? record[key] : undefined, rest, nextValue)
      : nextValue,
  };
};

const updateEqBandValue = (
  value: JsonObject | undefined,
  bandId: string,
  property: string,
  nextValue: number,
): JsonObject => {
  if (!value || !Array.isArray(value.bands)) return value ?? {};
  let field = "q";
  if (property === "frequencyHz") field = "frequency";
  if (property === "gainDb") field = "gainDb";
  return {
    ...value,
    bands: value.bands.map((band) => {
      return isJsonObject(band) && band.id === bandId
        ? { ...band, [field]: nextValue }
        : band;
    }),
  };
};

export const overlayEffectAutomationValue = (
  value: JsonObject,
  parameterId: string,
  nextValue: number,
): JsonObject => {
  const eq = parseEqBandParameterId(parameterId);
  const path = parameterId.split(".").slice(1);
  if (!isJsonObject(value.state)) {
    return eq
      ? updateEqBandValue(value, eq.bandId, eq.property, nextValue)
      : updateAutomationPath(value, path, nextValue);
  }
  return {
    ...value,
    state: eq
      ? updateEqBandValue(value.state, eq.bandId, eq.property, nextValue)
      : updateAutomationPath(value.state, path, nextValue),
  };
};
