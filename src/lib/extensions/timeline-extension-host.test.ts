import { expect, test } from "bun:test";
import { createExtensionKernel } from "./extension-kernel";
import { createTimelineExtensionHost } from "./timeline-extension-host";

test("dispatches the browser shortcut through the kernel after synchronous fallback readiness", async () => {
  let toggles = 0;
  const kernel = createExtensionKernel();
  const host = createTimelineExtensionHost({
    browser: { toggle: () => { toggles += 1; } },
  }, kernel);
  const context = { editableTarget: false };

  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: false, key: "B" },
    context,
  )).toBeTrue();
  expect(toggles).toBe(1);

  expect(await host.activation).toBeTrue();
  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: false, key: "b" },
    context,
  )).toBeTrue();
  await Promise.resolve();
  expect(toggles).toBe(2);
  await host.dispose();
  expect(kernel.snapshot().commands).toEqual([]);
});

test("rejects editable targets, shifted chords, and commands after disposal", async () => {
  let toggles = 0;
  const host = createTimelineExtensionHost({
    browser: { toggle: () => { toggles += 1; } },
  });
  await host.activation;

  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: false, key: "b" },
    { editableTarget: true },
  )).toBeFalse();
  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: true, key: "b" },
    { editableTarget: false },
  )).toBeFalse();
  expect(toggles).toBe(0);

  await host.dispose();
  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: false, key: "b" },
    { editableTarget: false },
  )).toBeFalse();
  expect(toggles).toBe(0);
});

test("keeps the synchronous fallback safe when activation fails", async () => {
  let toggles = 0;
  const kernel = {
    ...createExtensionKernel(),
    activate: async () => {
      throw new Error("activation failed");
    },
  };
  const host = createTimelineExtensionHost({
    browser: { toggle: () => { toggles += 1; } },
  }, kernel);

  expect(await host.activation).toBeFalse();
  expect(host.shortcuts.execute(
    { mod: true, alt: true, shift: false, key: "b" },
    { editableTarget: false },
  )).toBeTrue();
  expect(toggles).toBe(1);
  await host.dispose();
});
