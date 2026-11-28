import { RuleTester } from "oxlint/plugins-dev";

import { noArrayFilterMapRule } from "./no-array-filter-map.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "arrayFilterMap" };

tester.run("anti-slop/no-array-filter-map", noArrayFilterMapRule, {
  valid: [
    "const out = [1, 2].values().filter(Boolean).map(String).toArray();",
    "const out = [1, 2].flatMap((n) => (n > 1 ? [n] : []));",
    "const out = [1, 2].filter(Boolean).filter(Number);",
    "const out = unknownValue.filter(Boolean).map(String);",
  ],
  invalid: [
    { name: "filter then map", code: "const out = [1, 2].filter(Boolean).map(String);", errors: [error] },
    { name: "map then filter", code: "const out = [1, 2].map(String).filter(Boolean);", errors: [error] },
    {
      name: "typed array parameter",
      code: "function f(items: number[]) { return items.filter(Boolean).map(String); }",
      errors: [error],
    },
  ],
});
