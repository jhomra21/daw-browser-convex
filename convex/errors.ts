import { ConvexError } from "convex/values";
import { controlErrorSchemaV1, type ControlErrorV1 } from "@daw-browser/control";

/** Throws the typed error the API edge reads with `readControlErrorV1`; the message stays the user-visible text. */
export function fail(
  code: ControlErrorV1["code"],
  message: string,
  actionIndex?: number,
  details?: Record<string, string>,
): never {
  throw new ConvexError(controlErrorSchemaV1.parse({ version: "v1", code, message, actionIndex, details }));
}
