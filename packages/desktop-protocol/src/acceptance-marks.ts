import { z } from "zod"

export const ae08RendererMarkChannel = "daw:ae08:renderer-mark"

// Renderer marks of the edit-to-publish path. Each carries a commit key (control-*), the hash of the edited target (ui-*, the moment
// the UI commits an edit made in the app window) or an adoption key (the rest).
export const ae08RendererMarks = z.enum([
  "control-handler-entry", "control-reload-before-done", "control-commit-done", "control-store-emitted",
  "control-parameters-delivered", "control-parameters-undelivered",
  "ui-parameter-commit", "ui-automation-override", "ui-automation-reenable", "ui-device-insert", "ui-device-remove", "ui-editor-open", "ui-undo", "ui-redo",
  "compile-start", "compile-instruments-ready", "compile-render-state-ready", "compile-processors-ready", "compile-end",
  "lane-admitted", "fence-open", "prepare-sent",
  "prepare-reply-received", "bind-request-sent",
  "bind-states-configured", "bind-progress-reply", "bind-progress-read",
  "armed-cover-end", "armed-stage-returned", "armed-prime-start", "armed-prime-end",
  "asset-create-request", "asset-create-reply", "asset-page-write-request", "asset-page-write-reply",
  "asset-range-request", "asset-range-reply", "asset-candidate-pages-start", "asset-candidate-pages-end",
  "asset-sources-ready", "asset-instrument-states-ready",
  "refill-compile-start", "refill-compile-end",
])

export const ae08RendererMarkSchema = z.tuple([ae08RendererMarks, z.string().max(64)])
