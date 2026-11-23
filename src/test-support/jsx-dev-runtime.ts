// Solid 2 compiles JSX in the Vite plugin. @solidjs/web exports a jsx-dev-runtime subpath for JSX types only: at runtime it
// resolves to dist/web.dev.js, which has no jsxDEV. Bun transpiles .tsx with a jsxDEV import from the jsxImportSource, which
// then resolves to a module without that export and aborts the whole test file at link time.
// Modules imported by tests only for their pure helpers never call it, so this stub fails loudly if one ever does.
const unsupported = (): never => {
  throw new Error("JSX cannot be rendered under bun test; mount it through the browser fixtures.");
};

export const jsxDEV = unsupported;
export const jsx = unsupported;
export const jsxs = unsupported;
export const Fragment = unsupported;
