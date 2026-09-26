// Small archives retain the existing import path; large stored archives
// must not materialize every asset in the renderer heap.
export const importLocalDawProjectFile = (
  file: File,
  importer: {
    legacy: (file: File) => Promise<string>
    streamed: (file: File) => Promise<string>
  },
) => file.size > 40 * 1024 * 1024 ? importer.streamed(file) : importer.legacy(file)
