// Main → renderer push channel for long-running-operation progress.
// Single-window app: broadcasting to all windows avoids threading the
// originating WebContents through every call site (registerDataSource is
// reached both from IPC handlers and from workbook load re-registration).
import { BrowserWindow } from 'electron'
import type { OpProgress } from '../shared/types'

export function emitProgress(p: OpProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('op:progress', p)
  }
}
