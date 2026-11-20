import { describe, expect, test } from "bun:test";
import { desktopApplicationMenuCommands } from "@daw-browser/desktop-protocol/application-menu";
import { gridDenominators } from "~/components/timeline/grid-options";
import { userCommands } from "./user-commands";

describe("user commands", () => {
  test("cover exactly the desktop menu commands", () => {
    expect(Object.keys(userCommands).sort()).toEqual([...desktopApplicationMenuCommands].sort());
  });

  test("grid denominator commands match the grid options", () => {
    const commandDenominators = desktopApplicationMenuCommands
      .filter((command) => command.startsWith("set-grid-denominator-"))
      .map((command) => Number(command.slice("set-grid-denominator-".length)));

    expect(commandDenominators).toEqual(gridDenominators);
  });
});
