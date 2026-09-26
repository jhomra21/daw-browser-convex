import { expect, test } from "bun:test"
import { readDiagnosticInstanceId } from "./diagnostic-instance-id"

test("reads only the length-delimited identity before later diagnostic extensions", () => {
  const frame = Buffer.concat([Buffer.from("instance"), Buffer.from([0, 0, 0, 1, 65])])
  expect(readDiagnosticInstanceId(frame, 0, 8)).toBe("instance")
  expect(() => readDiagnosticInstanceId(frame, 0, 300)).toThrow()
})
