export const runTimelineMutationAfterRecordingSettlement = async (input: {
  isRecording: () => boolean
  stopRecording: () => Promise<void>
  provisionalClipId: () => string | null
  mutate: () => Promise<void>
}) => {
  if (input.isRecording()) await input.stopRecording()
  if (input.isRecording() || input.provisionalClipId()) return false
  await input.mutate()
  return true
}
