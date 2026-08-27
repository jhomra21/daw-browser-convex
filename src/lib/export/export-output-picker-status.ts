type ExportOutputPickerListener = (open: boolean) => void

let outputPickerOpen = false
const listeners = new Set<ExportOutputPickerListener>()

const notify = () => {
  for (const listener of listeners) listener(outputPickerOpen)
}

export const exportOutputPickerStatus = {
  current: () => outputPickerOpen,
  set(open: boolean) {
    if (open === outputPickerOpen) return
    outputPickerOpen = open
    notify()
  },
  subscribe(listener: ExportOutputPickerListener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
