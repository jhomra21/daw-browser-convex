export async function copyText(value?: string) {
  if (!value || !navigator.clipboard?.writeText) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {}
}
