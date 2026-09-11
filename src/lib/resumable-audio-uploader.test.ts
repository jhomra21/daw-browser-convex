import { expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { uploadAudioFile, type ResumableAudioUploadHttpError } from './resumable-audio-uploader'
import { CapabilityFile } from './desktop/capability-file'
import { resumableUploadMaximumBytes } from '@daw-browser/control'

test('resumable uploader resumes accepted parts and completes without client-owned part lists', async () => {
  const file = new File([new Uint8Array(16 * 1024 * 1024 + 12)], 'long.wav', { type: 'audio/wav' })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/resumable-uploads') {
      return new Response(JSON.stringify({ assetKey: 'asset-1', sessionId: 'session-1' }), { status: 201 })
    }
    if (url.endsWith('/session-1')) {
      return new Response(JSON.stringify({
        assetKey: 'asset-1',
        sessionId: 'session-1',
        status: 'uploading',
        partSizeBytes: 8 * 1024 * 1024,
        partCount: 3,
        acceptedBytes: 8 * 1024 * 1024,
        parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: 8 * 1024 * 1024 }],
      }))
    }
    if (url.endsWith('/2') || url.endsWith('/3')) return new Response('{}', { status: 200 })
    if (url.endsWith('/complete')) {
      return new Response(JSON.stringify({ assetKey: 'asset-1', url: '/asset-1' }), { status: 201 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const result = await uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'resumable-test-key',
    assetKey: 'asset-1',
    file,
    fetch: fetcher,
  })
  expect(result).toEqual({ assetKey: 'asset-1', url: '/asset-1' })
  expect(requests.filter((request) => request.init?.method === 'PUT')).toHaveLength(2)
  expect(requests.at(-1)?.init?.method).toBe('POST')
  expect(requests.at(-1)?.init?.body).toBeUndefined()
})

test('resumable uploader does not reuse persisted state for a different file', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'changed.wav', { type: 'audio/wav' })
  const storage = {
    values: new Map<string, string>(),
    getItem(key: string) { return this.values.get(key) ?? null },
    setItem(key: string, value: string) { this.values.set(key, value) },
    removeItem(key: string) { this.values.delete(key) },
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const contentSha256 = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  storage.setItem('daw-resumable-upload:project-1:changed-file', JSON.stringify({
    projectId: 'project-1',
    assetKey: 'stale-asset',
    sessionId: 'stale-session',
    contentSha256: '0'.repeat(64),
    sizeBytes: file.size,
    name: file.name,
    mimeType: file.type,
  }))
  const previousLocalStorage = globalThis.localStorage
  Reflect.set(globalThis, 'localStorage', storage)
  try {
    const requests: string[] = []
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === '/api/resumable-uploads') {
        return new Response(JSON.stringify({ assetKey: 'fresh-asset', sessionId: 'fresh-session' }), { status: 201 })
      }
      return new Response('{}', { status: 500 })
    }
    await expect(uploadAudioFile({
      projectId: 'project-1',
      idempotencyKey: 'changed-file',
      assetKey: 'fresh-asset',
      file,
      fetch: fetcher,
    })).rejects.toThrow('could not be resumed')
    expect(requests[0]).toBe('/api/resumable-uploads')
    expect(storage.getItem('daw-resumable-upload:project-1:changed-file')).toContain(contentSha256)
  } finally {
    Reflect.set(globalThis, 'localStorage', previousLocalStorage)
  }
})

test('resumable uploader returns the completed server asset without uploading parts', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'complete.wav', { type: 'audio/wav' })
  const requests: string[] = []
  const result = await uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'completed-test-key',
    assetKey: 'requested-asset',
    file,
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      return new Response(JSON.stringify({
        assetKey: 'completed-asset',
        sessionId: 'completed-session',
        completed: true,
        url: '/samples/completed-asset',
      }), { status: 200 })
    },
  })
  expect(result).toEqual({ assetKey: 'completed-asset', url: '/samples/completed-asset' })
  expect(requests).toEqual(['/api/resumable-uploads'])
})

test('resumable uploader clears terminal sessions before starting a fresh attempt', async () => {
  for (const terminalStatus of ['failed', 'aborted']) {
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], `${terminalStatus}.wav`, { type: 'audio/wav' })
    const storage = new Map<string, string>()
    const previousLocalStorage = globalThis.localStorage
    Reflect.set(globalThis, 'localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    let startAttempts = 0
    try {
      const result = await uploadAudioFile({
        projectId: 'project-1',
        idempotencyKey: `${terminalStatus}-retry-key`,
        assetKey: `${terminalStatus}-asset`,
        file,
        fetch: async (input, init) => {
          const url = String(input)
          if (url === '/api/resumable-uploads') {
            startAttempts += 1
            return new Response(JSON.stringify({
              assetKey: `${terminalStatus}-${startAttempts}`,
              sessionId: `${terminalStatus}-session-${startAttempts}`,
            }), { status: 201 })
          }
          if (url.endsWith(`${terminalStatus}-session-1`)) {
            return new Response(JSON.stringify({
              assetKey: `${terminalStatus}-1`,
              sessionId: `${terminalStatus}-session-1`,
              status: terminalStatus,
              partSizeBytes: 8 * 1024 * 1024,
              partCount: 2,
              acceptedBytes: 0,
              parts: [],
            }))
          }
          if (url.endsWith(`${terminalStatus}-session-2`)) {
            return new Response(JSON.stringify({
              assetKey: `${terminalStatus}-2`,
              sessionId: `${terminalStatus}-session-2`,
              status: 'uploading',
              partSizeBytes: 8 * 1024 * 1024,
              partCount: 2,
              acceptedBytes: 0,
              parts: [],
            }))
          }
          if (init?.method === 'PUT') return new Response('{}', { status: 200 })
          if (url.endsWith('/complete')) {
            return new Response(JSON.stringify({
              assetKey: `${terminalStatus}-2`,
              url: `/${terminalStatus}-2`,
            }), { status: 201 })
          }
          throw new Error(`Unexpected request: ${url}`)
        },
      })
      expect(result).toEqual({ assetKey: `${terminalStatus}-2`, url: `/${terminalStatus}-2` })
      expect(startAttempts).toBe(2)
      expect(storage.size).toBe(0)
    } finally {
      Reflect.set(globalThis, 'localStorage', previousLocalStorage)
    }
  }
})

test('resumable uploader restarts once when completion returns a terminal status', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'completion-terminal.wav', { type: 'audio/wav' })
  let starts = 0
  let completions = 0
  const result = await uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'completion-terminal-key',
    assetKey: 'completion-terminal-asset',
    file,
    fetch: async (input, init) => {
      const url = String(input)
      if (url === '/api/resumable-uploads') {
        starts += 1
        return new Response(JSON.stringify({
          assetKey: `completion-terminal-asset-${starts}`,
          sessionId: `completion-terminal-session-${starts}`,
        }), { status: 201 })
      }
      if (url.endsWith('completion-terminal-session-1')
        || url.endsWith('completion-terminal-session-2')) {
        return new Response(JSON.stringify({
          assetKey: `completion-terminal-asset-${starts}`,
          sessionId: `completion-terminal-session-${starts}`,
          status: 'uploading',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 2,
          acceptedBytes: 0,
          parts: [],
        }))
      }
      if (init?.method === 'PUT') return new Response('{}', { status: 200 })
      if (url.endsWith('/complete')) {
        completions += 1
        return completions === 1
          ? new Response(JSON.stringify({
            assetKey: 'completion-terminal-asset-1',
            sessionId: 'completion-terminal-session-1',
            status: 'failed',
          }), { status: 422 })
          : new Response(JSON.stringify({
            assetKey: 'completion-terminal-asset-2',
            url: '/completion-terminal-asset-2',
          }), { status: 201 })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
  })
  expect(result).toEqual({ assetKey: 'completion-terminal-asset-2', url: '/completion-terminal-asset-2' })
  expect(starts).toBe(2)
  expect(completions).toBe(2)
})

test('resumable uploader stops after a repeated terminal completion status', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'repeated-terminal.wav', { type: 'audio/wav' })
  let starts = 0
  let completions = 0
  await expect(uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'repeated-terminal-key',
    assetKey: 'repeated-terminal-asset',
    file,
    fetch: async (input, init) => {
      const url = String(input)
      if (url === '/api/resumable-uploads') {
        starts += 1
        return new Response(JSON.stringify({
          assetKey: `repeated-terminal-asset-${starts}`,
          sessionId: `repeated-terminal-session-${starts}`,
        }), { status: 201 })
      }
      if (url.endsWith('repeated-terminal-session-1')
        || url.endsWith('repeated-terminal-session-2')) {
        return new Response(JSON.stringify({
          assetKey: `repeated-terminal-asset-${starts}`,
          sessionId: `repeated-terminal-session-${starts}`,
          status: 'uploading',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 2,
          acceptedBytes: 0,
          parts: [],
        }))
      }
      if (init?.method === 'PUT') return new Response('{}', { status: 200 })
      if (url.endsWith('/complete')) {
        completions += 1
        return new Response(JSON.stringify({
          assetKey: `repeated-terminal-asset-${starts}`,
          sessionId: `repeated-terminal-session-${starts}`,
          status: 'aborted',
        }), { status: 409 })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
  })).rejects.toThrow('another terminal session')
  expect(starts).toBe(2)
  expect(completions).toBe(2)
})

test('resumable uploader preserves HTTP status in typed failures', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'failed.wav', { type: 'audio/wav' })
  await expect(uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'status-test-key',
    assetKey: 'failed-asset',
    file,
    fetch: async () => new Response('{}', { status: 413 }),
  })).rejects.toMatchObject({
    name: 'ResumableAudioUploadHttpError',
    status: 413,
  } satisfies Partial<ResumableAudioUploadHttpError>)
})

test('rejects an oversized capability file before reading or starting a session', async () => {
  let reads = 0
  let requests = 0
  const controller = new AbortController()
  const file = new CapabilityFile({
    requestId: 'request-1',
    token: '0'.repeat(64),
    size: resumableUploadMaximumBytes + 1,
    readChunk: async () => {
      reads += 1
      return new Uint8Array()
    },
    signal: controller.signal,
  }, 'oversized.wav', 'audio/wav')

  await expect(uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'oversized-capability-key',
    assetKey: 'oversized-asset',
    file,
    fetch: async () => {
      requests += 1
      return new Response('{}', { status: 500 })
    },
  })).rejects.toMatchObject({ name: 'ResumableAudioUploadHttpError', status: 413 })
  expect(reads).toBe(0)
  expect(requests).toBe(0)
})

test('resumable uploader retries transient verification responses within its deadline', async () => {
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'retry.wav', { type: 'audio/wav' })
  let completionAttempts = 0
  const result = await uploadAudioFile({
    projectId: 'project-1',
    idempotencyKey: 'retry-test-key',
    assetKey: 'retry-asset',
    file,
    fetch: async (input) => {
      const url = String(input)
      if (url === '/api/resumable-uploads') {
        return new Response(JSON.stringify({ assetKey: 'retry-asset', sessionId: 'retry-session' }), { status: 201 })
      }
      if (url.endsWith('/retry-session')) {
        return new Response(JSON.stringify({
          assetKey: 'retry-asset', sessionId: 'retry-session', status: 'uploading',
          partSizeBytes: 8 * 1024 * 1024, partCount: 2, acceptedBytes: 0, parts: [],
        }))
      }
      if (url.endsWith('/1') || url.endsWith('/2')) return new Response('{}', { status: 200 })
      if (url.endsWith('/complete')) {
        completionAttempts += 1
        return completionAttempts === 1
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ assetKey: 'retry-asset', url: '/retry-asset' }), { status: 201 })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
  })
  expect(result).toEqual({ assetKey: 'retry-asset', url: '/retry-asset' })
  expect(completionAttempts).toBe(2)
})
