import { RuleTester } from "oxlint/plugins-dev";

import { noReduceAccumulatorCopyRule } from "./no-reduce-accumulator-copy.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "accumulatorCopy" };

tester.run("anti-slop/no-reduce-accumulator-copy", noReduceAccumulatorCopyRule, {
  valid: [
    "const out = items.reduce((acc, item) => { acc[item.id] = item; return acc; }, {});",
    "const out = items.reduce((acc, item) => { acc.push(item); return acc; }, []);",
    "const out = items.reduce((acc, item) => Object.assign({}, item), {});",
    "const out = Object.assign({}, base, extra);",
  ],
  invalid: [
    {
      name: "Object.assign copy",
      code: "const out = items.reduce((acc, item) => Object.assign({}, acc, item), {});",
      errors: [error],
    },
    {
      name: "Array.from copy",
      code: "const out = items.reduce((acc, item) => { const next = Array.from(acc); next.push(item); return next; }, []);",
      errors: [error],
    },
    {
      name: "array concat copy",
      code: "const out = items.reduce((acc, item) => acc.concat(item), []);",
      errors: [error],
    },
  ],
});
