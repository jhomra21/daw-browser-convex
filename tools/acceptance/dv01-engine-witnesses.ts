// DV-01 step E: runs the engine-runtime rows of BOUNDARY-DESIGN §6.4 against a real AudioContext in Chromium and writes
// the JSON witness. The browser side is dv01-engine-witnesses.browser-runtime.ts; this driver bundles it, opens it through
// agent-browser (no dev server), asks for each row in turn and fails when any assertion of any row does not hold.
//   bun tools/acceptance/dv01-engine-witnesses.ts [output.json]
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { z } from "zod";

const root = resolve(import.meta.dir, "../..");
const defaultOutput = `${root}/acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/witnesses/stepE-r2-engine-rows.json`;
const output = process.argv[2] ?? defaultOutput;

const rowSchema = z.object({
  row: z.string(),
  observed: z.record(z.string(), z.union([z.string(), z.number()])),
  checks: z.array(z.object({ name: z.string(), expected: z.string(), actual: z.string(), pass: z.boolean() })),
});

const fixtureHtml = async () => {
  const result = await build({
    root,
    logLevel: "error",
    configFile: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.VITE_CONVEX_URL": '"https://fixture.convex.cloud"',
      "import.meta.env.BASE_URL": JSON.stringify(`file://${root}/public/`),
    },
    plugins: [solidPlugin(), {
      name: "dv01-engine-cloud-stubs",
      enforce: "pre",
      resolveId: (id, importer) => importer?.endsWith("/live-mixer-runtime.ts") && id === "./effects/compressor-chain-state"
        ? "\0dv01-observed-compressor" : undefined,
      load(id) {
        if (id === "\0dv01-observed-compressor") return `export { observeCompressorChainState as createCompressorChainState } from ${JSON.stringify(`${root}/tools/acceptance/dv01-engine-witnesses.browser-runtime.ts`)}`;
        if (id === `${root}/src/lib/auth-client.ts`) {
          return "export const authClient = { getSession: async () => ({ data: null }), signOut: async () => undefined };";
        }
        if (id === `${root}/src/lib/convex.ts`) {
          return `
            export { api as convexApi } from ${JSON.stringify(`${root}/convex/_generated/api.js`)};
            export const convexClient = { mutation: async () => { throw new Error("Cloud mutation in engine fixture") }, query: async () => undefined };
            export const useConvexQuery = () => ({ data: undefined, status: "success", isPending: false, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) });
          `;
        }
        return undefined;
      },
    }],
    resolve: { alias: { "~": `${root}/src` } },
    build: {
      write: false,
      minify: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
      lib: { entry: `${root}/tools/acceptance/dv01-engine-witnesses.browser-runtime.ts`, formats: ["iife"], name: "dv01EngineRows" },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!bundle || !("output" in bundle)) throw new Error("Expected the engine rows bundle.");
  const chunk = bundle.output.find((value) => value.type === "chunk");
  if (!chunk) throw new Error("Engine rows JavaScript missing.");
  return `<!doctype html><meta charset="utf-8"><body><script>window.bootErrors=[];window.addEventListener("error",e=>window.bootErrors.push(e.message+" "+(e.error&&e.error.stack)));window.addEventListener("unhandledrejection",e=>window.bootErrors.push(String(e.reason&&e.reason.stack||e.reason)))</script><script>${chunk.code.replaceAll("</script", "<\\/script")}</script>`;
};

const sha256 = async (path: string) => createHash("sha256").update(await Bun.file(path).bytes()).digest("hex");

const directory = `/tmp/dv01-engine-witnesses-${crypto.randomUUID()}`;
await mkdir(directory);
await Bun.write(`${directory}/index.html`, await fixtureHtml());
const session = `dv01-engine-witnesses-${crypto.randomUUID()}`;
const { AGENT_BROWSER_CDP: _cdp, AGENT_BROWSER_SESSION: _session, ...inherited } = process.env;
const env = { ...inherited, AGENT_BROWSER_ALLOW_FILE_ACCESS: "1" };
const browser = async (...args: string[]) => {
  const child = Bun.spawn(["agent-browser", "--session", session, ...args], { env, stdout: "pipe", stderr: "pipe" });
  // One bounded deadline per command, not a poll: a hung agent-browser child (a row that never settles) must fail the gate
  // instead of hanging it. It is cleared on every exit, a rejected stream or process promise included.
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`agent-browser ${args.join(" ")}: ${error || out}`);
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
};
// The page promise resolves when the row has finished, so there is nothing to poll.
const evalJson = async (expression: string) => JSON.parse(JSON.parse(
  await browser("eval", `Promise.resolve(${expression}).then(value => JSON.stringify(value ?? null))`),
));

const rows: z.infer<typeof rowSchema>[] = [];
let pageErrors: string[] = [];
try {
  await browser("open", `file://${directory}/index.html`);
  const names = z.array(z.string()).parse(await evalJson("window.engineRows ? window.engineRows.names : null"));
  for (const name of names) {
    rows.push(rowSchema.parse(await evalJson(`engineRows.run(${JSON.stringify(name)}).catch(error => { throw new Error(String(error && error.stack || error)) })`)));
  }
  pageErrors = z.array(z.string()).parse(await evalJson("window.bootErrors"));
} finally {
  await browser("close").catch(() => undefined);
}

const failed = rows.flatMap((row) => row.checks.filter((entry) => !entry.pass).map((entry) => `${row.row}: ${entry.name} (expected ${entry.expected}, actual ${entry.actual})`));
const product = ["packages/audio-engine/src/chain-admission.ts", "packages/audio-engine/src/live-mixer-runtime.ts", "packages/audio-engine/src/master-fx-runtime.ts", "src/lib/sampler-buffer-sync.ts"];
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  environment: "Chromium AudioContext through agent-browser, bundled with vite (no dev server)",
  productSha256: Object.fromEntries(await Promise.all(product.map(async (file) => [file, await sha256(`${root}/${file}`)]))),
  passed: failed.length === 0,
  failed,
  pageErrors,
  rows,
}, null, 2)}\n`);
console.log(`${rows.length} rows, ${rows.reduce((total, row) => total + row.checks.length, 0)} assertions, ${failed.length} failed -> ${output}`);
for (const line of failed) console.log(`FAIL ${line}`);
process.exit(failed.length === 0 ? 0 : 1);
