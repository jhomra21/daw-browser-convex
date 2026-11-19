import { vstEditorCapturedStateAckChannel } from "@daw-browser/desktop-protocol/ipc-channels";
import type { IpcMain } from "electron";
import { z } from "zod";

const editorStateAckSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ok: z.boolean(),
  error: z.string().optional(),
}).strict();

export const registerVstEditorStateAckIpc = (dependencies: {
  ipcMain: IpcMain;
  allowed: (event: Electron.IpcMainInvokeEvent) => boolean;
  takePendingEditorStateAck: (requestId: string) => {
    resolve: () => void;
    reject: (error: Error) => void;
  } | undefined;
}) => {
  dependencies.ipcMain.handle(vstEditorCapturedStateAckChannel, (event, value) => {
    if (!dependencies.allowed(event)) return { accepted: false };
    const parsed = editorStateAckSchema.safeParse(value);
    if (!parsed.success) return { accepted: false };
    const pending = dependencies.takePendingEditorStateAck(parsed.data.requestId);
    if (!pending) return { accepted: false };
    if (parsed.data.ok) pending.resolve();
    else pending.reject(new Error(parsed.data.error ?? "Editor state persistence failed."));
    return { accepted: true };
  });
};
