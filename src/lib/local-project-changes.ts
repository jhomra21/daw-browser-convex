const changeTarget = new EventTarget()
const projectStateChangeTarget = new EventTarget()

// Per-project count of notified changes, scoped like `changeTarget`: it lives for the page and is never reset, so a
// reader that sampled it before a read knows every change up to that number was already visible to the read.
const changeSequences = new Map<string, number>()

export const localProjectChangeSequence = (projectId: string) => changeSequences.get(projectId) ?? 0

export const notifyLocalProjectChanged = (projectId: string) => {
  const sequence = localProjectChangeSequence(projectId) + 1
  changeSequences.set(projectId, sequence)
  changeTarget.dispatchEvent(new CustomEvent(projectId))
  return sequence
}

export const notifyLocalProjectStateChanged = (projectId: string) => {
  projectStateChangeTarget.dispatchEvent(new CustomEvent(projectId))
}

export const subscribeToLocalProjectChanges = (
  projectId: string,
  callback: () => void,
) => {
  changeTarget.addEventListener(projectId, callback)
  return () => changeTarget.removeEventListener(projectId, callback)
}

export const subscribeToLocalProjectStateChanges = (
  projectId: string,
  callback: () => void,
) => {
  projectStateChangeTarget.addEventListener(projectId, callback)
  return () => projectStateChangeTarget.removeEventListener(projectId, callback)
}
