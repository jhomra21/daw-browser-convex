import { expect, test } from "bun:test";
import {
  controlOperationCatalog,
  listControlOperationDescriptors,
  parseControlOperationId,
  supportsControlOperation,
} from "@daw-browser/control";
import {
  canonicalControlClientOperationMap,
  createJsonlRpcAdapter,
} from "@daw-browser/control-sdk";
import {
  desktopControlOperationDescriptorsV1,
  desktopControlOperationsV1,
} from "@daw-browser/desktop-protocol";
import { canonicalControlOperations } from "@daw-browser/control-cli";

const operationIds = listControlOperationDescriptors().map((descriptor) => parseControlOperationId(descriptor.id));

test("canonical catalog maps every represented client and desktop operation", () => {
  const clientOperations = [
    ...Object.values(canonicalControlClientOperationMap.control),
    canonicalControlClientOperationMap.projects.list,
  ];
  expect([...clientOperations].sort().join(",")).toBe(
    operationIds.filter((id) => id !== "project.current").sort().join(","),
  );
  expect([...desktopControlOperationsV1].sort().join(",")).toBe(
    operationIds.filter((id) => id !== "project.list" && id !== "project.current").sort().join(","),
  );
  for (const operation of desktopControlOperationsV1) {
    expect(desktopControlOperationDescriptorsV1[operation].canonicalInput).toBe(
      controlOperationCatalog[operation].input,
    );
    expect(desktopControlOperationDescriptorsV1[operation].canonicalOutput).toBe(
      controlOperationCatalog[operation].output,
    );
  }
});

test("targets, CLI aliases, and JSONL discovery remain truthful", () => {
  expect(supportsControlOperation("project.current", "cloud")).toBeFalse();
  expect(supportsControlOperation("project.current", "desktop")).toBeTrue();
  for (const operation of Object.values(canonicalControlOperations)) {
    expect(operation in controlOperationCatalog).toBeTrue();
  }
  const adapter = createJsonlRpcAdapter({
    invoker: {
      target: "cloud",
      invoke: async () => { throw new Error("not called"); },
    },
  });
  expect(adapter.methods()).not.toContain("project.current");
  expect(adapter.methods()).toContain("control.commit");
});
