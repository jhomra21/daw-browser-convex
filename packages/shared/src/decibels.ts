export const linearFromDb = (db: number) => 10 ** (db / 20)

// Zero, negative, and NaN linear values map to -Infinity dB.
export const dbFromLinear = (linear: number) => (
  linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY
)
