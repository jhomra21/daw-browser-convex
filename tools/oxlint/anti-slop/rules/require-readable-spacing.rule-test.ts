import { RuleTester } from "oxlint/plugins-dev";

import { requireReadableSpacingRule } from "./require-readable-spacing.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/require-readable-spacing", requireReadableSpacingRule, {
  valid: [
    "import a from 'a';\nimport b from 'b';\n\nexport const value = a + b;\n",
    "const a = 1;\nconst b = 2;\n",
    "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: string | number) {}\n",
    "function f() {\n  const a = 1;\n  const b = 2;\n\n  return a + b;\n}\n",
  ],
  invalid: [
    {
      name: "import followed by code",
      code: "import a from 'a';\nexport const value = a;\n",
      output: "import a from 'a';\n\nexport const value = a;\n",
      errors: 1,
    },
    {
      name: "return after bindings",
      code: "function f() {\n  const a = 1;\n  return a;\n}\n",
      output: "function f() {\n  const a = 1;\n\n  return a;\n}\n",
      errors: 1,
    },
    {
      name: "function declarations",
      code: "function a() {}\nfunction b() {}\n",
      output: "function a() {}\n\nfunction b() {}\n",
      errors: 1,
    },
  ],
});
