type FilePickerAcceptType = {
  description?: string
  accept: Record<string, string[]>
}

type OpenFilePickerOptions = {
  multiple?: boolean
  types?: FilePickerAcceptType[]
}

type FileSystemPermissionMode = 'read' | 'readwrite'

type FileSystemHandlePermissionDescriptor = {
  mode?: FileSystemPermissionMode
}

type FileSystemGetDirectoryOptions = {
  create?: boolean
}

type FileSystemGetFileOptions = {
  create?: boolean
}

type FileSystemWritableFileStream = WritableStream & {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

type IdleRequestCallback = (deadline: IdleDeadline) => void

interface IdleDeadline {
  didTimeout: boolean
  timeRemaining(): number
}

interface FileSystemHandle {
  name: string
  kind: 'file' | 'directory'
  queryPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable?: () => Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: 'directory'
  getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

interface StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>
}

interface Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  showSaveFilePicker?: (options?: { suggestedName?: string; types?: FilePickerAcceptType[] }) => Promise<FileSystemFileHandle>
  requestIdleCallback: (callback: IdleRequestCallback) => number
  cancelIdleCallback: (handle: number) => void
}
