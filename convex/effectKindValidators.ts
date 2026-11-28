import { v } from "convex/values";

// Validators are built at module load from plain values; the literal type of each member is the union of the values.
export const literalUnion = <Value extends string>(values: readonly Value[]) => v.union(...values.map((value) => v.literal(value)));
