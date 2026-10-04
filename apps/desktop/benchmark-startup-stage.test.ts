import { expect, test } from "bun:test"
import { benchmarkStartupStage, benchmarkLoadFailure } from "./benchmark-startup-stage"

test("only emits bounded startup labels for disposable benchmark app", () => {
  const received: string[] = []
  benchmarkStartupStage("1", "before-native-helper", (line) => received.push(line))
  benchmarkStartupStage(undefined, "window-created", (line) => received.push(line))
  expect(received).toEqual(["[benchmark-startup] before-native-helper"])
})

test("reports only bounded navigation failure code without URL disclosure", () => {
  const received: string[] = []
  benchmarkLoadFailure("1", -6, "private://secret", (line) => received.push(line))
  expect(received).toEqual(["[benchmark-startup] load-failed code=-6"])
})
