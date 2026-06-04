export const deleteProjectSample = async (
  projectId: string,
  assetKey: string,
): Promise<void> => {
  const response = await fetch(`/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(assetKey)}`, {
    method: 'DELETE',
  })
  if (!response.ok) throw new Error('Sample delete failed.')
}
