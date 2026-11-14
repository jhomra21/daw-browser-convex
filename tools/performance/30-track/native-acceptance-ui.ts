import { browserCommand } from "../browser-harness"
import { z } from "zod"

// Existing spool acceptance helpers, shared without importing its whole runner.
export const nested = (text: string) => {
  let value = JSON.parse(text)
  for (let count = 0; count < 3; count++) {
    const encoded = z.string().safeParse(value)
    if (!encoded.success) break
    try { value = JSON.parse(encoded.data) } catch { break }
  }
  return value
}
export const waitForAcceptanceEvent = async <Value>(event: Promise<Value>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([event, new Promise<null>((resolve) => {
      // Existing bounded OS/acceptance deadline, never recurring native polling.
      timer = setTimeout(() => resolve(null), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}
export const acknowledgeRetainedSourcesNotice = async (
  session: string, label: string, browser = browserCommand,
) => {
  const notice = nested(await browser(session, ["eval",
    `(()=>{const dialog=document.querySelector('[role="dialog"]');if(!dialog)return {present:false};const title=dialog.querySelector('[role="heading"],h1,h2,h3')?.textContent?.trim()??'';const description=dialog.querySelector('p')?.textContent?.replace(/\\s+/g,' ').trim()??'';const buttons=[...dialog.querySelectorAll('button')].map(button=>button.textContent?.trim()??'');return {present:true,title,description,buttons}})()`]))
  if (!notice.present) return false
  if (notice.title !== "Recording"
    || notice.description !== "Native recording sources are retained for this project. They have not been discarded."
    || notice.buttons.filter((buttonLabel: string) => buttonLabel === "OK").length !== 1
    || notice.buttons.length !== 2 || !notice.buttons.includes("Close"))
    throw new Error(`Unexpected product dialog ${label}.`)
  await browser(session, ["eval",
    `(()=>{const dialog=document.querySelector('[role="dialog"]');const buttons=[...(dialog?.querySelectorAll('button')??[])].filter(button=>button.textContent?.trim()==='OK');if(buttons.length!==1)throw new Error('Retained-source acknowledgment button is not unique.');buttons[0]?.click();return true})()`])
  return true
}
