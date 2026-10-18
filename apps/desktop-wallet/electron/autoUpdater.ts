import { BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

import { IS_RC, isIpcSenderValid } from './utils'

export const configureAutoUpdater = () => {
  autoUpdater.autoDownload = true
  autoUpdater.allowPrerelease = IS_RC
}

export const setupAutoUpdaterListeners = (mainWindow: BrowserWindow) => {
  autoUpdater.on('download-progress', (info) => mainWindow.webContents.send('updater:download-progress', info))

  autoUpdater.on('error', (error) => mainWindow.webContents.send('updater:error', error))

  autoUpdater.on('update-downloaded', (event) => mainWindow.webContents.send('updater:updateDownloaded', event))
}

export const handleAutoUpdaterUserActions = () => {
  ipcMain.handle('updater:checkForUpdates', async ({ senderFrame }) => {
    if (!isIpcSenderValid(senderFrame)) return null

    try {
      const result = await autoUpdater.checkForUpdates()

      // Download errors are already forwarded by the updater's error listener.
      // Consume the separate promise without delaying the version response.
      result?.downloadPromise?.catch(() => undefined)

      return result ? { version: result.updateInfo.version, isUpdateAvailable: result.isUpdateAvailable } : undefined
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('updater:quitAndInstallUpdate', ({ senderFrame }) => {
    if (!isIpcSenderValid(senderFrame)) return null

    autoUpdater.quitAndInstall()
  })
}
