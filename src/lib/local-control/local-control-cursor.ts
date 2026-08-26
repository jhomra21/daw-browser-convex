import { canonicalJson } from '@daw-browser/control'
import { isJsonObject, isJsonNumber, isJsonString, type JsonValue } from '@daw-browser/shared'
import { z } from 'zod'

type LocalControlCursor = {
  version: 1
  kind: 'history' | 'recoveries'
  createdAt: number
  id: string
  terminal?: true
}

const maxCursorBytes = 2_048
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const isCursor = (value: JsonValue): value is JsonValue & LocalControlCursor => {
  if (!isJsonObject(value)) return false
  const row = value
  return row.version === 1
    && (row.kind === 'history' || row.kind === 'recoveries')
    && isJsonNumber(row.createdAt) && Number.isInteger(row.createdAt) && row.createdAt >= 0
    && isJsonString(row.id) && row.id.length > 0
    && (row.terminal === undefined || row.terminal === true)
    && Object.keys(row).every((key) => (
      key === 'version' || key === 'kind' || key === 'createdAt' || key === 'id' || key === 'terminal'
    ))
}

const base64url = (bytes: Uint8Array) => {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const decodeBase64url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid cursor.')
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(binary, (entry) => entry.charCodeAt(0))
}

export const encodeLocalControlCursor = (cursor: LocalControlCursor) => {
  const text = canonicalJson(cursor)
  if (encoder.encode(text).byteLength > maxCursorBytes) throw new Error('Invalid cursor.')
  return base64url(encoder.encode(text))
}

export const parseLocalControlCursor = (
  value: string | undefined,
  kind: LocalControlCursor['kind'],
) => {
  if (value === undefined) return undefined
  try {
    if (encoder.encode(value).byteLength > maxCursorBytes) throw new Error('Invalid cursor.')
    const text = decoder.decode(decodeBase64url(value))
    if (encoder.encode(text).byteLength > maxCursorBytes) throw new Error('Invalid cursor.')
    const parsed = z.json().parse(JSON.parse(text))
    if (!isCursor(parsed) || parsed.kind !== kind || canonicalJson(parsed) !== text) {
      throw new Error('Invalid cursor.')
    }
    return parsed
  } catch {
    throw new Error('Invalid cursor.')
  }
}
