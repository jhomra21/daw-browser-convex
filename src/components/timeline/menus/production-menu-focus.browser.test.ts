import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { z } from "zod";

const browserSnapshotSchema = z.object({
  calls: z.array(z.string()),
  activeId: z.string(),
  activeText: z.string(),
  activeRole: z.string(),
  activeInMenu: z.boolean(),
  viewExpanded: z.string().nullable(),
  menuVisible: z.boolean(),
  menuItems: z.array(z.string()),
});
type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;

test("production View menu preserves keyboard ownership and Escape focus return", async () => {
  const directory = `/tmp/daw-production-menu-${crypto.randomUUID()}`;
  const repositoryRoot = new URL("../../../../", import.meta.url).pathname;
  const evidence = directory;
  const session = `daw-production-menu-${crypto.randomUUID()}`;
  const spaceSession = `daw-production-menu-space-${crypto.randomUUID()}`;
  const stages: Partial<Record<
    | "menuOpenedForSelection"
    | "selectedMenuItemBeforeEnter"
    | "menuShortcutTargetBeforeDelete"
    | "menuShortcutTargetBeforeControlD"
    | "afterEnter"
    | "menuOpenImmediatelyBeforeEscape"
    | "afterEscape"
    | "arrangementDelete"
    | "menuShortcutTargetBeforeSpace"
    | "afterSpace"
    | "afterUnmountDelete",
    BrowserSnapshot
  >> = {};
  const makeBrowser = (browserSession: string) => async (...args: string[]) => {
    const env = { ...process.env };
    delete env.AGENT_BROWSER_CDP;
    delete env.AGENT_BROWSER_SESSION;
    const child = Bun.spawn(["agent-browser", "--session", browserSession, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Keep each isolated CLI call bounded and clear its watchdog after completion.
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`agent-browser ${args[0]} failed: ${stderr || stdout}`);
      return stdout.trim();
    } finally {
      clearTimeout(timeout);
    }
  };
  const browser = makeBrowser(session);
  const spaceBrowser = makeBrowser(spaceSession);
  const readSnapshotWith = async (runBrowser: typeof browser) =>
    browserSnapshotSchema.parse(JSON.parse(JSON.parse(await runBrowser(
      "eval",
      "JSON.stringify(window.productionMenuFocus.snapshot())",
    ))));
  const readSnapshot = () => readSnapshotWith(browser);
  const clickView = async () => {
    const snapshot = await browser("snapshot", "-i");
    const trigger = snapshot.match(/^.*menuitem "View".*ref=(e\d+)/m)?.[1];
    if (!trigger) throw new Error(`Could not find the production View trigger in the browser snapshot:\n${snapshot}`);
    await browser("click", `@${trigger}`);
  };
  const moveFocusIntoViewMenu = async () => {
    await browser("press", "ArrowDown");
    let snapshot = await readSnapshot();
    if (!snapshot.activeInMenu) {
      await browser("press", "ArrowDown");
      snapshot = await readSnapshot();
    }
    if (!snapshot.menuItems.includes(snapshot.activeText)) {
      throw new Error(`Could not move focus into the open View menu: ${JSON.stringify(snapshot)}`);
    }
    expect(snapshot.activeRole).toBe("menuitem");
    expect(snapshot.activeInMenu).toBe(true);
    return snapshot;
  };

  await mkdir(directory, { recursive: true });
  try {
    const result = await build({
      root: repositoryRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [solidPlugin()],
      resolve: { alias: { "~": `${repositoryRoot}src` } },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: new URL("./production-menu-focus.browser-runtime.tsx", import.meta.url).pathname,
          formats: ["iife"],
          name: "productionMenuFocusFixture",
        },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !("output" in output)) throw new Error("Expected a single production menu fixture bundle.");
    const bundle = output.output.find((chunk) => chunk.type === "chunk")?.code;
    expect(bundle).toBeDefined();
    await Bun.write(
      `${directory}/index.html`,
      `<!doctype html><body><script>window.addEventListener("error", (event) => { window.__fixtureError = event.message; });</script><script>${bundle ?? ""}</script>`,
    );
    await browser("open", `file://${directory}/index.html`);
    await browser("wait", "--fn", "!!window.productionMenuFocus || !!window.__fixtureError");
    const startup = z.object({ ready: z.boolean(), error: z.string().nullable() }).parse(JSON.parse(JSON.parse(await browser(
      "eval",
      "JSON.stringify({ready: !!window.productionMenuFocus, error: window.__fixtureError ?? null})",
    ))));
    expect(startup).toEqual({ ready: true, error: null });

    await clickView();
    await browser("wait", "--fn", "window.productionMenuFocus.snapshot().menuVisible");
    let state = await readSnapshot();
    expect(state.viewExpanded).toBe("true");
    expect(state.menuItems).toContain("Assets Browser");
    stages.menuOpenedForSelection = state;
    const realTriggerOpened = state.viewExpanded === "true";
    const menuPopulated = state.menuItems.includes("Assets Browser");
    await browser("screenshot", `${evidence}/production-view-menu.png`);

    state = await moveFocusIntoViewMenu();
    expect(state.activeText).toContain("Assets Browser");
    expect(state.viewExpanded).toBe("true");
    stages.selectedMenuItemBeforeEnter = state;

    stages.menuShortcutTargetBeforeDelete = state;
    const callsBeforeDelete = [...state.calls];
    await browser("press", "Delete");
    state = await readSnapshot();
    expect(state.viewExpanded).toBe("true");
    expect(state.menuVisible).toBe(true);
    expect(state.menuItems).toContain(state.activeText);
    expect(state.activeRole).toBe("menuitem");
    expect(state.activeInMenu).toBe(true);
    expect(state.calls).toEqual(callsBeforeDelete);
    expect(state.calls).not.toContain("timeline:delete");
    const deleteShortcutSuppressedInMenu = !state.calls.includes("timeline:delete");

    expect(state.viewExpanded).toBe("true");
    expect(state.menuVisible).toBe(true);
    expect(state.menuItems).toContain(state.activeText);
    expect(state.activeRole).toBe("menuitem");
    expect(state.activeInMenu).toBe(true);
    const callsBeforeControlD = [...state.calls];
    stages.menuShortcutTargetBeforeControlD = state;
    await browser("press", "Control+d");
    state = await readSnapshot();
    expect(state.calls).toEqual(callsBeforeControlD);
    expect(state.viewExpanded).toBe("true");
    expect(state.menuVisible).toBe(true);
    const controlDShortcutSuppressedInMenu = state.calls.every((call) => !call.startsWith("timeline:"));

    const callsBeforeEnter = [...state.calls];
    await browser("press", "Enter");
    // Kobalte closes the menu after the item's onSelect runs, so wait for the close.
    await browser("wait", "--fn", "!window.productionMenuFocus.snapshot().menuVisible");
    state = await readSnapshot();
    expect(state.calls).toEqual([
      ...callsBeforeEnter,
      "view:browser-tab:assets",
      "view:browser-open",
    ]);
    expect(state.viewExpanded).not.toBe("true");
    expect(state.menuVisible).toBe(false);
    stages.afterEnter = state;
    const enterSelectedExactlyOnce =
      state.calls.slice(callsBeforeEnter.length).filter((call) => call === "view:browser-tab:assets").length === 1 &&
      state.calls.slice(callsBeforeEnter.length).filter((call) => call === "view:browser-open").length === 1;

    await clickView();
    await browser("wait", "--fn", "window.productionMenuFocus.snapshot().menuVisible");
    await browser(
      "wait",
      "--fn",
      "window.productionMenuFocus.snapshot().activeInMenu && window.productionMenuFocus.snapshot().activeRole === 'menuitem'",
    );
    state = await readSnapshot();
    expect(state.viewExpanded).toBe("true");
    expect(state.menuVisible).toBe(true);
    expect(state.activeRole).toBe("menuitem");
    expect(state.activeInMenu).toBe(true);
    stages.menuOpenImmediatelyBeforeEscape = state;
    const callsBeforeEscape = [...state.calls];
    await browser("press", "Escape");
    state = await readSnapshot();
    expect(state.viewExpanded).not.toBe("true");
    expect(state.menuVisible).toBe(false);
    expect(state.activeText).toBe("View");
    expect(state.activeRole).toBe("menuitem");
    expect(state.calls).toEqual(callsBeforeEscape);
    stages.afterEscape = state;
    const escapeRestoresTriggerFocus = state.activeText === "View" && state.viewExpanded !== "true";

    await browser("click", "#arrangement");
    state = await readSnapshot();
    expect(state.activeId).toBe("arrangement");
    await browser("press", "Delete");
    state = await readSnapshot();
    expect(state.calls).toContain("timeline:delete");
    stages.arrangementDelete = state;
    const arrangementShortcutResumesAfterRefocus = state.calls.includes("timeline:delete");
    const callsBeforeUnmount = [...state.calls];
    await browser("eval", "window.productionMenuFocus.dispose()");
    await browser("press", "Delete");
    state = await readSnapshot();
    expect(state.calls).toEqual(callsBeforeUnmount);
    await Bun.write(`${evidence}/disposed-snapshot.json`, JSON.stringify(state, null, 2));
    stages.afterUnmountDelete = state;

    await spaceBrowser("open", `file://${directory}/index.html`);
    await spaceBrowser("wait", "--fn", "!!window.productionMenuFocus");
    const initialSpaceSnapshot = await spaceBrowser("snapshot", "-i");
    const spaceViewTrigger = initialSpaceSnapshot.match(/^.*menuitem "View".*ref=(e\d+)/m)?.[1];
    if (!spaceViewTrigger) {
      throw new Error(`Could not find the View trigger for Space coverage:\n${initialSpaceSnapshot}`);
    }
    await spaceBrowser("click", `@${spaceViewTrigger}`);
    await spaceBrowser("wait", "--fn", "window.productionMenuFocus.snapshot().menuVisible");
    await spaceBrowser("wait", "--fn", "window.productionMenuFocus.snapshot().activeInMenu");
    const beforeSpace = await readSnapshotWith(spaceBrowser);
    expect(beforeSpace.viewExpanded).toBe("true");
    expect(beforeSpace.menuVisible).toBe(true);
    expect(beforeSpace.activeInMenu).toBe(true);
    stages.menuShortcutTargetBeforeSpace = beforeSpace;
    await spaceBrowser("press", "Space");
    const afterSpace = await readSnapshotWith(spaceBrowser);
    expect(afterSpace.menuVisible).toBe(true);
    expect(afterSpace.calls).not.toContain("timeline:space");
    const spaceDoesNotInvokeTimelineTransport = !afterSpace.calls.includes("timeline:space");
    stages.afterSpace = afterSpace;

    const checks = {
      realTriggerOpens: realTriggerOpened,
      menuIsPopulated: menuPopulated,
      enterSelectsActualItemOnce: enterSelectedExactlyOnce,
      spaceDoesNotInvokeTimelineTransport,
      deleteShortcutSuppressedInMenu,
      controlDShortcutSuppressedInMenu,
      escapeRestoresTriggerFocus,
      arrangementShortcutResumesAfterRefocus,
    };
    await Bun.write(`${evidence}/gates.json`, JSON.stringify(checks, null, 2));
    await Bun.write(`${evidence}/stages.json`, JSON.stringify(stages, null, 2));
    await Bun.write(`${evidence}/final-snapshot.json`, JSON.stringify(state, null, 2));
    expect(Object.values(checks).every(Boolean)).toBe(true);

    await Bun.write(`${evidence}/stages.json`, JSON.stringify(stages, null, 2));
    console.log(`Production menu focus evidence: ${evidence}`);
  } finally {
    await browser("close").catch(() => undefined);
    await spaceBrowser("close").catch(() => undefined);
    await rm(`${directory}/index.html`, { force: true });
  }
}, 120_000);
