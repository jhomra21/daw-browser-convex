// Stored ZIP32 only. Blob slices keep asset payloads out of the JS heap.
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const chunkSize = 65_536
const table = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const checksum = (data: Uint8Array, initial = 0xffffffff) => {
  let value = initial
  for (const byte of data) value = table[(value ^ byte) & 255] ^ (value >>> 8)
  return value >>> 0
}
const u16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true)
const u32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value, true)
const read16 = (view: DataView, offset: number) => view.getUint16(offset, true)
const read32 = (view: DataView, offset: number) => view.getUint32(offset, true)
const bounded = async function* (blob: Blob) {
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    yield new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer())
  }
}
const header = (length: number) => {
  const bytes = new Uint8Array(length)
  return { bytes, view: new DataView(bytes.buffer) }
}
const ensure32 = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Archive exceeds ZIP32 limits.')
}

export const writeStoredZip = async (
  entries: Iterable<{ name: string; file: Blob }>,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> => {
  const directory: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    if (!name.length || name.length > 0xffff || directory.length >= 0xffff) throw new Error('Invalid ZIP entry name or count.')
    ensure32(entry.file.size)
    ensure32(offset + 30 + name.length + entry.file.size)
    let crc = 0xffffffff
    for await (const chunk of bounded(entry.file)) crc = checksum(chunk, crc)
    crc = (crc ^ 0xffffffff) >>> 0
    const local = header(30 + name.length)
    u32(local.view, 0, 0x04034b50)
    u16(local.view, 4, 20)
    u32(local.view, 14, crc)
    u32(local.view, 18, entry.file.size)
    u32(local.view, 22, entry.file.size)
    u16(local.view, 26, name.length)
    local.bytes.set(name, 30)
    await write(local.bytes)
    for await (const chunk of bounded(entry.file)) await write(chunk)
    const central = header(46 + name.length)
    u32(central.view, 0, 0x02014b50)
    u16(central.view, 4, 20)
    u16(central.view, 6, 20)
    u32(central.view, 16, crc)
    u32(central.view, 20, entry.file.size)
    u32(central.view, 24, entry.file.size)
    u16(central.view, 28, name.length)
    u32(central.view, 42, offset)
    central.bytes.set(name, 46)
    directory.push(central.bytes)
    offset += local.bytes.length + entry.file.size
  }
  const start = offset
  for (const record of directory) {
    ensure32(offset + record.length)
    await write(record)
    offset += record.length
  }
  const end = header(22)
  u32(end.view, 0, 0x06054b50)
  u16(end.view, 8, directory.length)
  u16(end.view, 10, directory.length)
  u32(end.view, 12, offset - start)
  u32(end.view, 16, start)
  await write(end.bytes)
}

const readHeader = async (blob: Blob, offset: number, length: number) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > blob.size) throw new Error('Truncated ZIP archive.')
  return new DataView(await blob.slice(offset, offset + length).arrayBuffer())
}

export async function* readStoredZipEntries(blob: Blob): AsyncGenerator<{ name: string; file: Blob }> {
  let offset = 0
  const names = new Set<string>()
  const records: { name: string; crc: number; size: number; offset: number; file: Blob }[] = []
  while (true) {
    const signature = read32(await readHeader(blob, offset, 4), 0)
    if (signature !== 0x04034b50) break
    const local = await readHeader(blob, offset, 30)
    const flags = read16(local, 6)
    const size = read32(local, 18)
    const nameLength = read16(local, 26)
    const extraLength = read16(local, 28)
    if (read16(local, 8) !== 0 || flags !== 0 || size !== read32(local, 22) || !nameLength) throw new Error('Unsupported ZIP entry.')
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const name = decoder.decode(await blob.slice(nameStart, dataStart - extraLength).arrayBuffer())
    if (names.has(name)) throw new Error(`Archive contains duplicate entry "${name}".`)
    names.add(name)
    const file = blob.slice(dataStart, dataStart + size)
    if (file.size !== size) throw new Error('Truncated ZIP entry.')
    let crc = 0xffffffff
    for await (const chunk of bounded(file)) crc = checksum(chunk, crc)
    if (((crc ^ 0xffffffff) >>> 0) !== read32(local, 14)) throw new Error(`Archive contains corrupt bytes for "${name}".`)
    records.push({ name, crc: read32(local, 14), size, offset, file })
    offset = dataStart + size
  }
  const start = offset
  for (const record of records) {
    const central = await readHeader(blob, offset, 46)
    if (read32(central, 0) !== 0x02014b50 || read16(central, 10) !== 0 || read16(central, 8) !== 0 ||
      read16(central, 12) !== 0 || read32(central, 16) !== record.crc ||
      read32(central, 20) !== record.size || read32(central, 24) !== record.size ||
      read32(central, 42) !== record.offset || read16(central, 30) !== 0 || read16(central, 32) !== 0 ||
      decoder.decode(await blob.slice(offset + 46, offset + 46 + read16(central, 28)).arrayBuffer()) !== record.name) {
      throw new Error('Invalid ZIP directory.')
    }
    offset += 46 + read16(central, 28) + read16(central, 30) + read16(central, 32)
    if (offset > blob.size) throw new Error('Truncated ZIP directory.')
  }
  const end = await readHeader(blob, offset, 22)
  if (read32(end, 0) !== 0x06054b50 || read16(end, 4) !== 0 || read16(end, 6) !== 0 ||
    read16(end, 8) !== records.length || read16(end, 10) !== records.length || read32(end, 12) !== offset - start ||
    read32(end, 16) !== start || read16(end, 20) !== 0 || offset + 22 !== blob.size) {
    throw new Error('Invalid ZIP directory.')
  }
  for (const { name, file } of records) yield { name, file }
}
