export const createRecordingBlockTransit = (sequence: number) =>
  Number.isSafeInteger(sequence) && sequence >= 0 && sequence % 256 === 0
