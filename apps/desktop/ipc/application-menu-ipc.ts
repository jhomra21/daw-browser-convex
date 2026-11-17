import { desktopApplicationMenuStateSchema } from "@daw-browser/desktop-protocol/application-menu";
import { applicationMenuStateChannel } from "@daw-browser/desktop-protocol/ipc-channels";
import type { IpcMain } from "electron";
import type { z } from "zod";

export const registerApplicationMenuIpc = (dependencies: {
  ipcMain: Pick<IpcMain, "on">;
  applicationMenuStateAllowed: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean;
  applicationMenuController: {
    setState: (state: z.infer<typeof desktopApplicationMenuStateSchema>) => void;
  };
}) => {
  dependencies.ipcMain.on(applicationMenuStateChannel, (event, value) => {
    if (!dependencies.applicationMenuStateAllowed(event)) return;
    const parsed = desktopApplicationMenuStateSchema.safeParse(value);
    if (parsed.success) dependencies.applicationMenuController.setState(parsed.data);
  });
};
