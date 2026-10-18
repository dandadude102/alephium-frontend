import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from 'electron'
import type { UpdateCheckResult } from 'electron-updater'

import { configureAutoUpdater, handleAutoUpdaterUserActions, setupAutoUpdaterListeners } from './autoUpdater'

type IpcHandler = (event: Pick<IpcMainInvokeEvent, 'senderFrame'>) => unknown

const { updater, handlers, listeners, senderIsValid, settings } = vi.hoisted(() => ({
  updater: {
    autoDownload: false,
    allowPrerelease: false,
    checkForUpdates: vi.fn<() => Promise<UpdateCheckResult | null>>(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  },
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, (event: unknown) => void>(),
  senderIsValid: vi.fn(),
  settings: { IS_RC: false }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: { ...updater, on: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener) }
}))
vi.mock('./utils', () => ({
  get IS_RC() {
    return settings.IS_RC
  },
  isIpcSenderValid: senderIsValid
}))

const validFrame = { url: 'alephium://app' } as WebFrameMain
const invoke = (channel: string, senderFrame: WebFrameMain | null = validFrame) =>
  handlers.get(channel)!({ senderFrame })
const updateInfo = { version: '3.3.3', files: [], path: '', sha512: '', releaseDate: '' }

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  listeners.clear()
  settings.IS_RC = false
  senderIsValid.mockReturnValue(true)
  handleAutoUpdaterUserActions()
})

describe('automatic update downloads', () => {
  it.each([false, true])('enables auto-download and preserves prerelease selection (%s)', async (isRc) => {
    settings.IS_RC = isRc
    configureAutoUpdater()
    const { autoUpdater } = await import('electron-updater')

    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.allowPrerelease).toBe(isRc)
  })

  it('registers only check and install actions, without a renderer download action', () => {
    expect([...handlers.keys()]).toEqual(['updater:checkForUpdates', 'updater:quitAndInstallUpdate'])
  })

  it('returns the version without waiting for the automatic download', async () => {
    const downloadPromise = new Promise<string[]>(() => undefined)
    const catchDownload = vi.spyOn(downloadPromise, 'catch')
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo,
      versionInfo: updateInfo,
      downloadPromise
    })

    expect(await invoke('updater:checkForUpdates')).toEqual({ version: '3.3.3', isUpdateAvailable: true })
    expect(catchDownload).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(senderIsValid).toHaveBeenCalledWith(validFrame)
  })

  it('consumes a rejected download and forwards the updater error only once', async () => {
    const error = new Error('Download failed')
    const send = vi.fn()
    setupAutoUpdaterListeners({ webContents: { send } } as unknown as BrowserWindow)
    updater.checkForUpdates.mockImplementation(async () => {
      listeners.get('error')!(error)
      return { isUpdateAvailable: true, updateInfo, versionInfo: updateInfo, downloadPromise: Promise.reject(error) }
    })

    expect(await invoke('updater:checkForUpdates')).toEqual({ version: '3.3.3', isUpdateAvailable: true })
    await Promise.resolve()
    expect(send).toHaveBeenCalledExactlyOnceWith('updater:error', error)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('forwards progress and completion unchanged', () => {
    const send = vi.fn()
    setupAutoUpdaterListeners({ webContents: { send } } as unknown as BrowserWindow)
    const progress = { percent: 42 }
    listeners.get('download-progress')!(progress)
    listeners.get('update-downloaded')!(updateInfo)

    expect(send.mock.calls).toEqual([
      ['updater:download-progress', progress],
      ['updater:updateDownloaded', updateInfo]
    ])
  })

  it('retains manual-fallback signaling when the updater is unavailable', async () => {
    updater.checkForUpdates.mockResolvedValue(null)
    expect(await invoke('updater:checkForUpdates')).toBeUndefined()
  })

  it('preserves an ineligible result without requiring a download promise', async () => {
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo, versionInfo: updateInfo })
    expect(await invoke('updater:checkForUpdates')).toEqual({ version: '3.3.3', isUpdateAvailable: false })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains check failure handling', async () => {
    const error = new Error('Check failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    updater.checkForUpdates.mockRejectedValue(error)

    expect(await invoke('updater:checkForUpdates')).toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith(error)
    log.mockRestore()
  })

  it('rejects invalid senders for both remaining actions', async () => {
    senderIsValid.mockReturnValue(false)

    expect(await invoke('updater:checkForUpdates', null)).toBeNull()
    expect(invoke('updater:quitAndInstallUpdate', null)).toBeNull()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('preserves the valid-sender quit-and-install action', () => {
    invoke('updater:quitAndInstallUpdate')
    expect(senderIsValid).toHaveBeenCalledWith(validFrame)
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
