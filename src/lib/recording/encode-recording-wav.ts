import { encodePlanarFloat32Wav } from '@daw-browser/audio-engine/recording-encode-wav'

type RecordingPcmDescriptor = {
  sessionId: string
  sampleRate: number
  channelCount: number
  capturedFrames: number
  byteLength: number
}

type EncodedRecordingWav = {
  file: File
  fileName: string
  mimeType: 'audio/wav'
  remove: () => Promise<void>
}

const RECORDING_DIRECTORY = 'recording-sessions'
const PCM_FILE = 'capture.pcm'
const WAV_FILE = 'capture.wav'
const BLOCK_HEADER_BYTES = Uint32Array.BYTES_PER_ELEMENT

const getSessionDirectory = async (sessionId: string) => {
  const root = await navigator.storage.getDirectory()
  const recordings = await root.getDirectoryHandle(RECORDING_DIRECTORY)
  return recordings.getDirectoryHandle(sessionId)
}

const removeRecordingTempSession = async (sessionId: string): Promise<void> => {
  const root = await navigator.storage.getDirectory()
  const recordings = await root.getDirectoryHandle(RECORDING_DIRECTORY)
  await recordings.removeEntry(sessionId, { recursive: true })
}

export const encodeRecordingWav = async (
  descriptor: RecordingPcmDescriptor,
  now: () => number = Date.now,
): Promise<EncodedRecordingWav> => {
  if (descriptor.capturedFrames === 0) {
    await removeRecordingTempSession(descriptor.sessionId).catch(() => undefined)
    throw new Error('Recording contained no audio frames.')
  }

  const directory = await getSessionDirectory(descriptor.sessionId)
  const pcmFile = await (await directory.getFileHandle(PCM_FILE)).getFile()
  const wavHandle = await directory.getFileHandle(WAV_FILE, { create: true })
  const createWritable = wavHandle.createWritable
  if (!createWritable) throw new Error('Origin-private file writes are unavailable.')
  const writable = await createWritable.call(wavHandle)
  async function* readBlocks() {
    let offset = 0
    while (offset < pcmFile.size) {
      const header = new Uint8Array(await pcmFile.slice(offset, offset + BLOCK_HEADER_BYTES).arrayBuffer())
      if (header.byteLength !== BLOCK_HEADER_BYTES) throw new Error('Recording PCM block header is truncated.')
      const frameCount = new DataView(header.buffer).getUint32(0, true)
      const payloadBytes = frameCount * descriptor.channelCount * Float32Array.BYTES_PER_ELEMENT
      if (frameCount === 0 || frameCount > 2048 || !Number.isSafeInteger(payloadBytes)) {
        throw new Error('Recording PCM block is invalid.')
      }
      const payload = new Uint8Array(await pcmFile.slice(
        offset + BLOCK_HEADER_BYTES,
        offset + BLOCK_HEADER_BYTES + payloadBytes,
      ).arrayBuffer())
      if (payload.byteLength !== payloadBytes) throw new Error('Recording PCM block payload is truncated.')
      const channels: Float32Array[] = []
      for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
        const samples = new Float32Array(frameCount)
        const source = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        for (let frame = 0; frame < frameCount; frame += 1) {
          samples[frame] = source.getFloat32(
            (channel * frameCount + frame) * Float32Array.BYTES_PER_ELEMENT,
            true,
          )
        }
        channels.push(samples)
      }
      yield { frameCount, channels }
      offset += BLOCK_HEADER_BYTES + payloadBytes
    }
  }
  try {
    await encodePlanarFloat32Wav({
      sampleRate: descriptor.sampleRate,
      channelCount: descriptor.channelCount,
      capturedFrames: descriptor.capturedFrames,
      blocks: readBlocks(),
      sink: {
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort(),
      },
    })
    const file = await wavHandle.getFile()
    const fileName = `recording-${now()}.wav`
    return {
      file: new File([file], fileName, { type: 'audio/wav' }),
      fileName,
      mimeType: 'audio/wav',
      remove: () => removeRecordingTempSession(descriptor.sessionId),
    }
  } catch (error) {
    await writable.abort().catch(() => undefined)
    await removeRecordingTempSession(descriptor.sessionId).catch(() => undefined)
    throw error
  }
}
