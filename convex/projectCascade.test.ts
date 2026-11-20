import { expect, test } from "bun:test";
import schema from "./schema";
import { cascadedProjectTables, retainedProjectTables } from "./projectCascade";

test("the project cascade lists every schema table keyed by projectId, or retains it on purpose", () => {
  const projectKeyed = Object.entries(schema.tables)
    .filter(([, table]) => "projectId" in table.validator.fields)
    .map(([name]) => name)
    .sort();

  expect([...cascadedProjectTables, ...retainedProjectTables].sort()).toEqual(projectKeyed);
});
