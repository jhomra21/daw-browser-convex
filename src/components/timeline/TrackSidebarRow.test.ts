import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const readTrackSidebarRow = () =>
  readFile(new URL("./TrackSidebarRow.tsx", import.meta.url), "utf8");

test("track name selects the track instead of muting it", async () => {
  const source = await readTrackSidebarRow();
  const nameButtonStart = source.indexOf(
    '<button\n            class={cn(\n              "flex flex-1',
  );
  const nameButtonEnd = source.indexOf(
    '\n          </button>',
    nameButtonStart,
  );

  expect(nameButtonStart).toBeGreaterThanOrEqual(0);
  expect(nameButtonEnd).toBeGreaterThan(nameButtonStart);

  const nameButton = source.slice(nameButtonStart, nameButtonEnd);
  expect(nameButton).toContain("sidebar().onTrackClick(track.id)");
  expect(nameButton).not.toContain("sidebar().onToggleMute(track.id)");
  expect(nameButton).toContain("title={`Select ${displayTrackName(track)}`}");
  expect(nameButton).not.toContain("bg-amber-500");
  expect(nameButton).not.toContain("Mute track");
  expect(nameButton).not.toContain("Unmute track");
});

test("collapsed and expanded controls expose mute buttons", async () => {
  const source = await readTrackSidebarRow();
  const collapsedStart = source.indexOf(
    '<Show when={track.collapsed}>\n          <div class="grid w-full grid-cols-5 gap-1">',
  );
  const collapsedEnd = source.indexOf(
    "\n        </Show>",
    collapsedStart,
  );
  const expandedStart = source.indexOf(
    '<Show when={!track.collapsed}>\n              <div class="grid grid-cols-5 gap-1">',
    source.indexOf("track-row-control-stack"),
  );
  const expandedEnd = source.indexOf(
    "\n            </Show>",
    expandedStart,
  );

  expect(collapsedStart).toBeGreaterThanOrEqual(0);
  expect(collapsedEnd).toBeGreaterThan(collapsedStart);
  expect(expandedStart).toBeGreaterThanOrEqual(0);
  expect(expandedEnd).toBeGreaterThan(expandedStart);

  const collapsedControls = source.slice(collapsedStart, collapsedEnd);
  const expandedControls = source.slice(expandedStart, expandedEnd);

  for (const controls of [collapsedControls, expandedControls]) {
    expect(controls).toMatch(/>\s*M\s*<\/button>/);
    expect(controls).toContain("sidebar().onToggleMute(track.id)");
    expect(controls).toContain('title={\n');
    expect(controls).toContain('"Unmute track"');
    expect(controls).toContain('"Mute track"');
    expect(controls).toContain("bg-amber-500");
  }
});
