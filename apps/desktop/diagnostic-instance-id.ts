export const readDiagnosticInstanceId = (frame: Buffer, offset: number, length: number) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
    || length > 256 || offset + length > frame.byteLength) {
    throw new RangeError("Invalid diagnostic instance identity bounds.")
  }
  return frame.toString("utf8", offset, offset + length)
}
