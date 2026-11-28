import { sha256 } from '@noble/hashes/sha2.js'
import { hexOfBytes } from './http'

export const hashFile = async (file: File) => {
  const hash = sha256.create()
  const reader = file.stream().getReader()

  try {
    while (true) {
      const result = await reader.read()

      if (result.done) break
      hash.update(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  return hexOfBytes(hash.digest())
}
