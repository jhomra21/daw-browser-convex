import { createLocalProjectId } from '~/lib/local-ids'
import { listLocalAssets, readLocalAssetBytes, writeLocalAssetFile } from '~/lib/local-assets'
import { deleteLocalProject, importLocalProject } from '~/lib/local-project-db'
import {
  buildProjectManifest,
  createRestoredProjectEntry,
  migrateProjectManifest,
} from '~/lib/project-manifest'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const readU32 = (bytes: Uint8Array, offset: number) => (
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
)

const u16 = (value: number) => new Uint8Array([value & 255, (value >>> 8) & 255])
const u32 = (value: number) => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255])

type ZipEntry = { name: string; bytes: Uint8Array }

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const createZip = (entries: ZipEntry[]) => {
  let offset = 0
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(entry.bytes.length), u32(entry.bytes.length),
      u16(name.length), u16(0), name, entry.bytes,
    ])
    locals.push(local)
    centrals.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(entry.bytes.length), u32(entry.bytes.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]))
    offset += local.length
  }
  const central = concat(centrals)
  return new Blob([concat([
    ...locals,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ])], { type: 'application/vnd.dawproject' })
}

const readZip = async (file: File): Promise<Map<string, Uint8Array>> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 30 < bytes.length) {
    const sig = readU32(bytes, offset)
    if (sig !== 0x04034b50) break
    const expectedCrc = readU32(bytes, offset + 14)
    const compressedSize = readU32(bytes, offset + 18)
    const nameLength = bytes[offset + 26] | (bytes[offset + 27] << 8)
    const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (nameStart > bytes.length || dataStart > bytes.length || dataEnd > bytes.length) {
      throw new Error('Archive contains a truncated zip entry.')
    }
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength))
    if (entries.has(name)) {
      throw new Error(`Archive contains duplicate entry "${name}".`)
    }
    const data = bytes.slice(dataStart, dataEnd)
    if (crc32(data) !== expectedCrc) {
      throw new Error(`Archive contains corrupt bytes for "${name}".`)
    }
    entries.set(name, data)
    offset = dataEnd
  }
  return entries
}

export const exportDawProjectArchive = async (projectId: string): Promise<Blob> => {
  const manifest = await buildProjectManifest(projectId, 'backup')
  const entries: ZipEntry[] = [
    { name: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
  ]
  for (const asset of await listLocalAssets(projectId)) {
    const result = await readLocalAssetBytes(projectId, asset.id)
    if (result.status !== 'ready') {
      throw new Error(`Archive export failed because "${asset.name}" is not readable.`)
    }
    entries.push({
      name: `assets/${asset.id}/${asset.storagePath}`,
      bytes: new Uint8Array(await result.file.arrayBuffer()),
    })
  }
  return createZip(entries)
}

export const importDawProjectArchive = async (file: File): Promise<string> => {
  const entries = await readZip(file)
  const manifestBytes = entries.get('manifest.json')
  if (!manifestBytes) throw new Error('Archive is missing manifest.json.')
  const manifest = migrateProjectManifest(JSON.parse(decoder.decode(manifestBytes)))
  const projectId = createLocalProjectId()
  const project = createRestoredProjectEntry({ ...manifest, projectId }, manifest.name)
  const assetFiles = manifest.assets.map((asset) => {
    const bytes = entries.get(`assets/${asset.id}/${asset.storagePath}`)
    if (!bytes) throw new Error(`Archive is missing asset bytes for "${asset.name}".`)
    return { asset, bytes }
  })
  try {
    await Promise.all(assetFiles.map(async ({ asset, bytes }) => {
      const assetBytes = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(assetBytes).set(bytes)
      await writeLocalAssetFile(projectId, asset.storagePath, new File([assetBytes], asset.name, { type: asset.mimeType }))
    }))
    await importLocalProject(project, {
      entities: manifest.entities,
      assets: manifest.assets,
      projectState: manifest.projectState,
      syncState: [],
    })
  } catch (error) {
    await deleteLocalProject(projectId)
    throw error
  }
  return projectId
}
