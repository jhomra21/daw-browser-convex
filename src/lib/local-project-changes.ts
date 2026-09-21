const changeTarget = new EventTarget()
const projectStateChangeTarget = new EventTarget()

export const notifyLocalProjectChanged = (projectId: string) => {
  changeTarget.dispatchEvent(new CustomEvent(projectId))
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
