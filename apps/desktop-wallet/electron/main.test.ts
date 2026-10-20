import { beforeEach, describe, expect, it, vi } from 'vitest'

// Import the real main entry and menu against a small Electron lifecycle model.
// Native dialogs still need a Windows smoke test; these tests cover our event wiring.
const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const windows = new Set<BrowserWindow>()
  const platform = { isMac: false, isWindows: true }
  let quitting = false
  let stopped = false

  const event = () => ({
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  })

  const stop = vi.fn(() => {
    stopped = true
  })

  class BrowserWindow extends EventEmitter {
    destroyed = false
    cancelBeforeUnload = false
    webContents = {
      send: vi.fn(),
      openDevTools: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    loadURL = vi.fn()
    loadFile = vi.fn()
    setIcon = vi.fn()
    isMinimized = vi.fn(() => false)
    minimize = vi.fn()
    restore = vi.fn()
    focus = vi.fn()
    show = vi.fn()

    constructor() {
      super()
      windows.add(this)
    }

    close() {
      if (this.destroyed) return

      const closeEvent = event()
      this.emit('close', closeEvent)
      // Electron does not emit closed when close or renderer beforeunload cancels it.
      if (closeEvent.defaultPrevented || this.cancelBeforeUnload) {
        quitting = false
        return
      }

      this.destroyed = true
      // NativeWindow marks itself closed before notifying observers, then leaves WindowList.
      this.emit('closed')
      windows.delete(this)

      if (windows.size === 0 && !stopped) {
        if (quitting) stop()
        else app.emit('window-all-closed')
      }
    }
  }

  const app = Object.assign(new EventEmitter(), {
    name: 'Alephium',
    setName: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(() => {
      // Electron ignores a repeated quit while it is already closing windows.
      if (quitting || stopped) return

      const beforeQuitEvent = event()
      app.emit('before-quit', beforeQuitEvent)
      quitting = !beforeQuitEvent.defaultPrevented
      if (!quitting) return

      if (windows.size === 0) stop()
      else [...windows].forEach((window) => window.close())
    })
  })

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    on: vi.fn(),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler))
  }
  const Menu = {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn()
  }
  const cleanupThemeListeners = vi.fn()
  const handleWindowsWalletConnectDeepLink = vi.fn()

  return {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    handlers,
    platform,
    windows,
    stop,
    cleanupThemeListeners,
    handleWindowsWalletConnectDeepLink,
    reset() {
      app.removeAllListeners()
      windows.clear()
      handlers.clear()
      platform.isMac = false
      platform.isWindows = true
      quitting = false
      stopped = false
    }
  }
})

vi.mock('electron', () => ({
  ...electron,
  nativeImage: { createFromPath: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() }
}))
vi.mock('electron-is-dev', () => ({ default: false }))
vi.mock('electron-context-menu', () => ({ default: vi.fn() }))
vi.mock('./appProtocol', () => ({ registerAppProtocol: vi.fn() }))
vi.mock('./autoUpdater', () => ({
  configureAutoUpdater: vi.fn(),
  handleAutoUpdaterUserActions: vi.fn(),
  setupAutoUpdaterListeners: vi.fn()
}))
vi.mock('./ledger', () => ({ setupLedgerDevicePermissions: vi.fn() }))
vi.mock('./nativeTheme', () => ({
  handleNativeThemeUserActions: vi.fn(),
  setupNativeThemeListeners: vi.fn(() => electron.cleanupThemeListeners)
}))
vi.mock('./onRamp', () => ({ handleOnRampWindows: vi.fn() }))
vi.mock('./paths', () => ({ ICON_PATH: 'icon.png' }))
vi.mock('./utils', () => ({
  get isMac() {
    return electron.platform.isMac
  },
  get isWindows() {
    return electron.platform.isWindows
  },
  IS_RC: false,
  CURRENT_VERSION: 'test',
  isAllowedExternalUrl: vi.fn(() => false),
  isIpcSenderValid: vi.fn((senderFrame) => senderFrame === 'wallet')
}))
vi.mock('./walletConnect', () => ({
  handleWalletConnectDeepLink: vi.fn(),
  handleWindowsWalletConnectDeepLink: electron.handleWindowsWalletConnectDeepLink,
  initializeWalletConnectDeepLinkUri: vi.fn(),
  setupWalletConnectDeepLinkIPCHandlers: vi.fn()
}))

const start = async (platform: 'windows' | 'linux' | 'mac' = 'windows') => {
  electron.platform.isMac = platform === 'mac'
  electron.platform.isWindows = platform === 'windows'
  await import('./main')
  electron.app.emit('ready')

  return [...electron.windows][0]
}

const invoke = (channel: string, senderFrame = 'wallet') => electron.handlers.get(channel)!({ senderFrame })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  electron.reset()
})

describe('main window lifecycle', () => {
  it.each(['windows', 'linux'] as const)(
    'quits after the main window closes on %s, including auxiliary windows',
    async (platform) => {
      const mainWindow = await start(platform)
      const auxiliaryWindow = new electron.BrowserWindow()

      mainWindow.close()

      expect(mainWindow.destroyed).toBe(true)
      expect(auxiliaryWindow.destroyed).toBe(true)
      expect(electron.windows.size).toBe(0)
      expect(electron.cleanupThemeListeners).toHaveBeenCalledOnce()
      // The existing before-quit guard and final window removal must not cause a quit loop.
      expect(electron.app.quit).toHaveBeenCalled()
      expect(electron.app.quit.mock.calls.length).toBeLessThanOrEqual(3)
      expect(electron.stop).toHaveBeenCalledOnce()
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('app:before-quit')
    }
  )

  it.each(['close', 'beforeunload'] as const)(
    'keeps all windows open when the main %s is canceled',
    async (cancellation) => {
      const mainWindow = await start()
      const auxiliaryWindow = new electron.BrowserWindow()
      if (cancellation === 'close') mainWindow.once('close', (event) => event.preventDefault())
      else mainWindow.cancelBeforeUnload = true

      invoke('window:close')

      expect(mainWindow.destroyed).toBe(false)
      expect(auxiliaryWindow.destroyed).toBe(false)
      expect(electron.app.quit).not.toHaveBeenCalled()
      expect(electron.cleanupThemeListeners).not.toHaveBeenCalled()

      mainWindow.cancelBeforeUnload = false
      invoke('window:close')

      expect(auxiliaryWindow.destroyed).toBe(true)
      expect(electron.stop).toHaveBeenCalledOnce()
    }
  )

  it('waits for the renderer quit handshake before closing any windows', async () => {
    const mainWindow = await start()
    const auxiliaryWindow = new electron.BrowserWindow()

    electron.app.quit()

    expect(mainWindow.webContents.send).toHaveBeenCalledExactlyOnceWith('app:before-quit')
    expect(mainWindow.destroyed).toBe(false)
    expect(auxiliaryWindow.destroyed).toBe(false)
    expect(electron.stop).not.toHaveBeenCalled()

    invoke('app:quit', 'untrusted')
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(mainWindow.destroyed).toBe(false)

    invoke('app:quit')

    expect(mainWindow.destroyed).toBe(true)
    expect(auxiliaryWindow.destroyed).toBe(true)
    expect(electron.stop).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).toHaveBeenCalledExactlyOnceWith('app:before-quit')
  })

  it('allows an auxiliary window to cancel quitting without repeated close attempts', async () => {
    const mainWindow = await start()
    const auxiliaryWindow = new electron.BrowserWindow()
    const cancelClose = vi.fn((event) => event.preventDefault())
    auxiliaryWindow.once('close', cancelClose)

    mainWindow.close()

    expect(mainWindow.destroyed).toBe(true)
    expect(auxiliaryWindow.destroyed).toBe(false)
    expect(cancelClose).toHaveBeenCalledOnce()
    expect(electron.app.quit).toHaveBeenCalledTimes(2)
    expect(electron.stop).not.toHaveBeenCalled()

    electron.app.quit()

    expect(auxiliaryWindow.destroyed).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(3)
    expect(electron.stop).toHaveBeenCalledOnce()
  })

  it('does not quit when only an auxiliary window closes or the main window minimizes', async () => {
    const mainWindow = await start()
    new electron.BrowserWindow().close()
    invoke('window:minimize')

    expect(mainWindow.minimize).toHaveBeenCalledOnce()
    expect(mainWindow.destroyed).toBe(false)
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('restores and focuses the running main window when a second instance starts', async () => {
    const mainWindow = await start()
    mainWindow.isMinimized.mockReturnValue(true)
    const args = ['alephium', 'alephium://wc']

    electron.app.emit('second-instance', {}, args)

    expect(mainWindow.restore).toHaveBeenCalledOnce()
    expect(mainWindow.focus).toHaveBeenCalledOnce()
    expect(electron.handleWindowsWalletConnectDeepLink).toHaveBeenCalledWith(mainWindow, args)
    expect(electron.windows.size).toBe(1)
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'keeps macOS running and reopens the wallet on activation (auxiliary window: %s)',
    async (withAuxiliaryWindow) => {
      const mainWindow = await start('mac')
      const auxiliaryWindow = withAuxiliaryWindow ? new electron.BrowserWindow() : undefined

      mainWindow.close()

      expect(electron.app.quit).not.toHaveBeenCalled()
      expect(electron.cleanupThemeListeners).toHaveBeenCalledOnce()
      expect(auxiliaryWindow?.destroyed).not.toBe(true)

      electron.app.emit('activate')

      const reopenedWindow = [...electron.windows].find((window) => window !== auxiliaryWindow)!
      expect(reopenedWindow).not.toBe(mainWindow)
      expect(reopenedWindow.destroyed).toBe(false)
      expect(reopenedWindow.loadFile).toHaveBeenCalledOnce()
      expect(electron.stop).not.toHaveBeenCalled()
    }
  )

  it('quits normally when the main window is the only window', async () => {
    const mainWindow = await start()

    mainWindow.close()

    expect(electron.stop).toHaveBeenCalledOnce()
    expect(electron.app.quit).toHaveBeenCalled()
    expect(electron.app.quit.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it.each(['windows', 'mac'] as const)('retains the native About menu role on %s', async (platform) => {
    await start(platform)

    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ submenu: expect.arrayContaining([{ role: 'about' }]) })])
    )
  })
})
