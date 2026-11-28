import { expect, test } from "bun:test";

import { listControlOperationDescriptors } from "@daw-browser/control";

import {
  desktopControlOperationSchemaV1,
  desktopControlOperationsV1,
  desktopHostOperationIds,
  desktopOperationSchemaV1,
} from "./index";

const hostOperations: readonly string[] = [
  "host.status", "host.vst.instances", "host.vst.parameters", "host.import.audio", "host.import.status",
  "host.import.cancel", "host.export.run", "host.export.status", "host.export.cancel", "transport.status",
  "transport.play", "transport.pause", "transport.stop", "transport.seek", "diagnostics.snapshot",
  "diagnostics.snapshot.v2",
];

const controlOperations: readonly string[] = [
  "control.capabilities", "control.snapshot", "control.preview", "control.commit",
  "control.requestApproval", "control.history", "control.recoveries",
];

test("operation enums keep their published members and order", () => {
  expect(Array.from(desktopOperationSchemaV1.options, String)).toEqual([...hostOperations, ...controlOperations]);
  expect(Array.from(desktopControlOperationSchemaV1.options, String)).toEqual(controlOperations.slice());
  expect(Array.from(desktopControlOperationsV1, String)).toEqual(controlOperations.slice());
  expect(Array.from(desktopHostOperationIds, String)).toEqual(hostOperations.slice());
});

test("the control operations are exactly the control.* ids of the control catalog", () => {
  const catalogIds = listControlOperationDescriptors().map((descriptor) => descriptor.id).filter((id) => id.startsWith("control."));

  expect(catalogIds.sort()).toEqual(Array.from(desktopControlOperationSchemaV1.options, String).sort());
});
