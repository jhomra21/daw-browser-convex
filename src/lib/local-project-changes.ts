const changeTarget = new EventTarget()

export const notifyLocalProjectChanged = (projectId: string) => {
  changeTarget.dispatchEvent(new CustomEvent(projectId))
}

export const subscribeToLocalProjectChanges = (
  projectId: string,
  callback: () => void,
) => {
  changeTarget.addEventListener(projectId, callback)
  return () => changeTarget.removeEventListener(projectId, callback)
}
