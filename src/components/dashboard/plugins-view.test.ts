import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("scans only after trust consent and refreshes catalog consumers", async () => {
  const source = await readFile(new URL("./plugins-view.tsx", import.meta.url), "utf8");
  const consentStart = source.indexOf("onChange={(event) => {");
  const consentEnd = source.indexOf("\n                }}", consentStart);
  if (consentStart < 0 || consentEnd < 0) throw new Error("Expected the trust consent handler.");
  const consent = source.slice(consentStart, consentEnd);
  const rescanStart = source.indexOf("const rescan = async () =>");
  const rescanEnd = source.indexOf("\n\n  return", rescanStart);
  if (rescanStart < 0 || rescanEnd < 0) throw new Error("Expected the rescan handler.");
  const rescan = source.slice(rescanStart, rescanEnd);
  const updateStart = source.indexOf("const update = (");
  const updateEnd = source.indexOf("\n\n  onMount", updateStart);
  if (updateStart < 0 || updateEnd < 0) throw new Error("Expected the catalog update handler.");
  const update = source.slice(updateStart, updateEnd);

  expect(consent).not.toContain("bridge?.scan()");
  expect(consent).toContain("saveVst3TrustAcknowledgement(localStorage)");
  expect(consent).toContain("setTrustAcknowledged(true)");
  expect(consent).toContain("void rescan()");
  expect(consent.match(/void rescan\(\)/g)).toHaveLength(1);
  expect(source).toContain("let activeScan: Promise<void> | undefined");
  expect(source).toContain("if (activeScan) return activeScan");
  expect(source).toContain("await activeUpdate");
  expect(rescan).toContain('canUseVst3CatalogAction("scan", trustAcknowledged())');
  expect(rescan).toContain("update(() => bridge?.scan()");
  expect(update).toContain("setCatalog(result.catalog)");
  expect(source).toContain('new Event("daw-plugin-catalog-changed")');
  expect(update).toContain("setMessage(result.error)");
  expect(update).toContain("The plug-in catalog could not be updated.");
  expect(source).toContain("autoHealStaleVst3Catalog");
  expect(source).toContain("trustAcknowledged()");
  expect(source).toContain("onCatalog: setCatalog");
});
