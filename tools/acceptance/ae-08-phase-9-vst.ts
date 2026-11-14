import type { Phase5Context } from "./ae-08-phase-5-fixture"
import { waitForUi } from "./ae-08-phase-5-fixture"

// The product UI steps that put the phase 6 test plug-in on the "Changed right" track and take it off again. They follow the trusted
// VST flow of `run()` in ae-08-live-graph.ts for phases 1-4 (plug-ins dashboard, trust acknowledgement, catalog scan, effects tab,
// plug-in button), with the test plug-in in place of ValhallaSupermassive.
type Ui = Pick<Phase5Context, "evaluate" | "interact" | "reload">
const browser = `[data-timeline-left-browser="1"]`
const testPluginButton = `[...document.querySelectorAll('${browser} button')].find(b=>/ae08.?test.?effect/i.test(b.textContent??''))`
const externalDevice = `document.querySelector('[data-external-effect-id]')`
const trackButton = (name: string) => `[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(${JSON.stringify(`: ${name}`)}))`

// Trust acknowledgement and catalog scan through the plug-ins dashboard, then the effects tab with the test plug-in listed and the
// track selected. Everything that reloads happens here, so the measured insert needs no reload.
const openPluginsDashboard = async (context: Ui) => {
  await context.evaluate(`(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','plugins');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()`)
  await waitForUi(context, "The VST3 plug-ins dashboard did not open", "Boolean(document.body.textContent?.includes('VST3 Plug-ins'))")
}

// Closes the dashboard and shows the effects browser of the plug-in track.
const openEffectsBrowser = async (context: Ui, trackName: string) => {
  await context.interact(["press", "Escape"])
  await waitForUi(context, "The timeline did not return after the plug-ins dashboard", `Boolean(document.querySelector('${browser}'))`)
  await context.interact(["click", `${browser} > div:first-child button:nth-child(2)`])
  // The packaged browser model persists the tab change but can leave the displayed tree stale until the product reloads.
  await context.reload()
  await waitForUi(context, "The effects browser did not return after the reload", `document.querySelector('${browser} input[type="search"]')?.getAttribute('placeholder')==='Search effects'`)
  await context.evaluate(`(()=>{const button=${trackButton(trackName)};if(!button)throw new Error('Plug-in track selector missing');button.click();return true})()`)
}

export const prepareTestPlugin = async (context: Ui, trackName: string) => {
  await openPluginsDashboard(context)
  await context.evaluate(`(()=>{const input=document.querySelector('input[type=checkbox]');if(!(input instanceof HTMLInputElement))throw new Error('Trust acknowledgement unavailable');input.click();return true})()`)
  await waitForUi(context, "The catalog scan found no VST3 bundle in the seeded directory",
    `(()=>{const row=[...document.querySelectorAll('[role="dialog"] *')].find(e=>e.textContent?.trim()==='Catalog scan');return Boolean(row?.parentElement?.textContent?.match(/[1-9]\\d* VST3 bundles? discovered/))})()`)
  await openEffectsBrowser(context, trackName)
  await waitForUi(context, "The test plug-in is not an enabled entry of the effects browser", `(()=>{const b=${testPluginButton};return Boolean(b&&!b.disabled)})()`)
}

// The refused insert of a bundle that is left untrusted: the dashboard still asks for the trust acknowledgement and offers neither a
// scan nor a directory, and the effects browser has no plug-in entry to insert, so no device card can appear.
// The effects tab is shown by `showUntrustedEffectsBrowser`, before the capture, because showing it reloads the app and a reload during the
// burst restarts the session the burst is measuring.
export const showUntrustedEffectsBrowser = (context: Ui, trackName: string) => openEffectsBrowser(context, trackName)

export const refuseUntrustedPlugin = async (context: Ui) => {
  await openPluginsDashboard(context)
  await waitForUi(context, "The plug-ins dashboard does not ask for the trust acknowledgement",
    `Boolean(document.body.textContent?.includes('I understand and trust the VST3 plug-ins I add.'))`)
  await waitForUi(context, "The plug-ins dashboard still offers a scan or a directory to an untrusted profile",
    `(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>['Rescan','Add directory'].includes(b.textContent?.trim()??''));return buttons.length===2&&buttons.every(b=>b.disabled)})()`)
  await context.interact(["press", "Escape"])
  await waitForUi(context, "The timeline did not return after the plug-ins dashboard", `Boolean(document.querySelector('${browser}'))`)
  await waitForUi(context, "An untrusted plug-in is offered by the effects browser or has a device card",
    `!${testPluginButton}&&!${externalDevice}`)
}

// The insert: one click on the plug-in's browser entry, settled when its device card is in the UI.
export const insertTestPlugin = async (context: Ui) => {
  await context.evaluate(`(()=>{const b=${testPluginButton};if(!b)throw new Error('Test plug-in entry missing');b.click();return true})()`)
  await waitForUi(context, "The inserted test plug-in has no device card", `Boolean(${externalDevice})`)
}

const cardButton = (label: string) => `[...(${externalDevice}?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()===${JSON.stringify(label)})`

// The editor: the card's Open UI button, settled when the card offers Close UI (the host's vst-editor-state line is the runner's own settle).
export const openTestPluginEditor = async (context: Ui) => {
  await context.evaluate(`(()=>{const button=${cardButton("Open UI")};if(!button)throw new Error('Test plug-in Open UI button missing');button.click();return true})()`)
  await waitForUi(context, "The test plug-in editor did not open", `Boolean(${cardButton("Close UI")})`)
}

// A failed plug-in is reported on its own device card.
export const awaitTestPluginFailure = (context: Ui) =>
  waitForUi(context, "The failed test plug-in is not reported on its device", `Boolean(${externalDevice}?.textContent?.includes('Plug-in failed'))`)

// The removal: the card's own Delete button (external-plugin-card.tsx), which removes the device as its context menu does. The
// context menu belongs to the card's header inside the boundary, so an event dispatched on the outer card never reaches it.
export const removeTestPlugin = async (context: Ui) => {
  await context.evaluate(`(()=>{const button=[...(${externalDevice}?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()==='Delete');
    if(!button)throw new Error('Test plug-in Delete button missing');button.click();return true})()`)
  await waitForUi(context, "The test plug-in device card is still in the UI", `!${externalDevice}`)
}
