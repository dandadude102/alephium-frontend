import '@/features/localization/i18n'

import { AnalyticsEvent, ONE_HOUR_MS } from '@alephium/shared'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProgressInfo, UpdateDownloadedEvent } from 'electron-updater'
import { StrictMode } from 'react'
import { ThemeProvider } from 'styled-components'

import AutoUpdateToastBox from '@/features/autoUpdate/AutoUpdateToastBox'
import { lightTheme } from '@/features/theme/themes'
import { links } from '@/utils/links'

vi.hoisted(() => vi.stubEnv('VITE_VERSION', '3.3.2'))

const { sendAnalytics, fetchRelease, openInWebBrowser } = vi.hoisted(() => ({
  sendAnalytics: vi.fn(),
  fetchRelease: vi.fn(),
  openInWebBrowser: vi.fn()
}))

vi.mock('@/features/analytics/useAnalytics', () => ({ default: () => ({ sendAnalytics }) }))
vi.mock('@alephium/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alephium/shared/api')>()),
  exponentialBackoffFetchRetry: fetchRelease
}))
vi.mock('@/utils/misc', () => ({ openInWebBrowser }))

const progressListeners = new Set<(info: ProgressInfo) => void>()
const downloadedListeners = new Set<(info: UpdateDownloadedEvent) => void>()
const errorListeners = new Set<(error: Error) => void>()
const updater = {
  checkForUpdates: vi.fn<() => Promise<{ version: string; isUpdateAvailable: boolean } | undefined>>(),
  onUpdateDownloadProgress: vi.fn((callback: (info: ProgressInfo) => void) => {
    progressListeners.add(callback)
    return vi.fn(() => progressListeners.delete(callback))
  }),
  onUpdateDownloaded: vi.fn((callback: (info: UpdateDownloadedEvent) => void) => {
    downloadedListeners.add(callback)
    return vi.fn(() => downloadedListeners.delete(callback))
  }),
  onError: vi.fn((callback: (error: Error) => void) => {
    errorListeners.add(callback)
    return vi.fn(() => errorListeners.delete(callback))
  }),
  quitAndInstallUpdate: vi.fn(),
  // Keep the old API in the fixture to catch accidental renderer-triggered downloads.
  startUpdateDownload: vi.fn()
}

const emitProgress = (percent: number) =>
  progressListeners.forEach((callback) =>
    callback({ percent, transferred: percent, total: 100, delta: 1, bytesPerSecond: 1 })
  )
const emitDownloaded = () =>
  downloadedListeners.forEach((callback) =>
    callback({ version: '3.3.3', files: [], path: '', sha512: '', releaseDate: '', downloadedFile: '/mock/update' })
  )
const emitError = (error = new Error('Validation failed')) => errorListeners.forEach((callback) => callback(error))
const renderToast = () =>
  render(
    <StrictMode>
      <ThemeProvider theme={lightTheme}>
        <AutoUpdateToastBox />
      </ThemeProvider>
    </StrictMode>
  )
const advanceTime = async (ms = 0) => act(async () => vi.advanceTimersByTimeAsync(ms))
const deferredVersion = () => {
  let resolve!: (version: string) => void
  const promise = new Promise<string>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise: promise.then((version) => ({ version, isUpdateAvailable: true })), resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
  vi.clearAllMocks()
  localStorage.clear()
  updater.checkForUpdates.mockResolvedValue({ version: '3.3.3', isUpdateAvailable: true })
  fetchRelease.mockResolvedValue({ json: async () => ({ tag_name: 'alephium-desktop-wallet@3.3.3' }) })
  window.electron = { updater } as unknown as Window['electron']
})

afterEach(() => {
  cleanup()
  delete window.electron
  vi.useRealTimers()
  expect(progressListeners.size).toBe(0)
  expect(downloadedListeners.size).toBe(0)
  expect(errorListeners.size).toBe(0)
})

afterAll(() => vi.unstubAllEnvs())

describe('AutoUpdateToastBox', () => {
  it('does not ask the renderer to start another download after the version response', async () => {
    renderToast()
    await advanceTime()

    expect(screen.getByText('Downloading version 3.3.3...')).toBeInTheDocument()
    expect(updater.startUpdateDownload).not.toHaveBeenCalled()
  })

  it('subscribes before checking and retains progress emitted before the version response', async () => {
    const version = deferredVersion()
    let listenerCounts: number[] = []
    updater.checkForUpdates.mockImplementation(() => {
      listenerCounts = [progressListeners.size, downloadedListeners.size, errorListeners.size]
      emitProgress(42.5)
      return version.promise
    })
    renderToast()
    await advanceTime()
    expect(listenerCounts).toEqual([1, 1, 1])
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

    await act(async () => version.resolve('3.3.3'))
    expect(screen.getByText('Downloading version 3.3.3...')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0.425')
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(fetchRelease).not.toHaveBeenCalled()
  })

  it('keeps completion that arrives before the version response', async () => {
    const version = deferredVersion()
    updater.checkForUpdates.mockImplementation(() => {
      emitDownloaded()
      return version.promise
    })
    renderToast()
    await advanceTime(1000)
    await act(async () => version.resolve('3.3.3'))

    expect(screen.getByText('Download finished')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Restart'))
    expect(updater.quitAndInstallUpdate).toHaveBeenCalledOnce()
    expect(sendAnalytics).toHaveBeenCalledWith({ event: AnalyticsEvent.AUTO_UPDATE_MODAL_CLICKED_RESTART })
  })

  it('keeps errors that arrive before the version response', async () => {
    const version = deferredVersion()
    const error = new Error('Download failed before check returned')
    updater.checkForUpdates.mockImplementation(() => {
      emitError(error)
      return version.promise
    })
    renderToast()
    await advanceTime()
    await act(async () => version.resolve('3.3.3'))

    expect(screen.getByText(error.toString())).toBeInTheDocument()
    expect(screen.getByText('Download failed')).toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
    expect(sendAnalytics).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      error,
      message: 'Auto-update download failed'
    })
  })

  it.each([500, 1500])('keeps validation errors authoritative %s ms after completion', async (delay) => {
    renderToast()
    await advanceTime()
    act(emitDownloaded)
    await advanceTime(delay)
    act(() => emitError())
    await advanceTime(2000)

    expect(screen.getByText('Download failed')).toBeInTheDocument()
    expect(screen.getByText('Error: Validation failed')).toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
  })

  it('does not replace a failure if completion is emitted afterward', async () => {
    renderToast()
    await advanceTime()
    act(() => {
      emitError()
      emitDownloaded()
    })
    await advanceTime(1000)

    expect(screen.getByText('Download failed')).toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
  })

  it('supports a later automatic retry after failure without duplicating subscriptions', async () => {
    renderToast()
    await advanceTime()
    act(() => emitError())
    updater.checkForUpdates.mockImplementation(async () => {
      emitProgress(60)
      emitDownloaded()
      return { version: '3.3.3', isUpdateAvailable: true }
    })
    // The existing throttle uses a strict > comparison, so move just past its next deadline.
    vi.setSystemTime(new Date(Date.now() + 1))
    await advanceTime(ONE_HOUR_MS + 1000)

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(progressListeners.size).toBe(1)
    expect(downloadedListeners.size).toBe(1)
    expect(errorListeners.size).toBe(1)
    expect(screen.getByText('Download finished')).toBeInTheDocument()
    expect(screen.queryByText('Error: Validation failed')).not.toBeInTheDocument()
    expect(screen.getByText('Restart')).toBeInTheDocument()
  })

  it('keeps a completed download when a later check has no eligible update', async () => {
    renderToast()
    await advanceTime()
    act(emitDownloaded)
    await advanceTime(1000)
    expect(screen.getByText('Restart')).toBeInTheDocument()

    updater.checkForUpdates.mockResolvedValue({ version: '3.3.2', isUpdateAvailable: false })
    vi.setSystemTime(new Date(Date.now() + 1))
    await advanceTime(ONE_HOUR_MS)

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Download finished')).toBeInTheDocument()
    expect(screen.getByText('Restart')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it.each([false, undefined])('keeps a failed download when a retry has no eligible update (%s)', async (eligible) => {
    renderToast()
    await advanceTime()
    act(() => emitError())
    updater.checkForUpdates.mockResolvedValue(
      eligible === false ? { version: '3.3.3', isUpdateAvailable: false } : undefined
    )
    vi.setSystemTime(new Date(Date.now() + 1))
    await advanceTime(ONE_HOUR_MS)

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Download failed')).toBeInTheDocument()
    expect(screen.getByText('Error: Validation failed')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
  })

  it('starts a different version after a completed update without offering the old restart', async () => {
    renderToast()
    await advanceTime()
    act(emitDownloaded)
    await advanceTime(1000)
    updater.checkForUpdates.mockResolvedValue({ version: '3.3.4', isUpdateAvailable: true })
    vi.setSystemTime(new Date(Date.now() + 1))
    await advanceTime(ONE_HOUR_MS)

    expect(screen.getByText('Downloading version 3.3.4...')).toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
    act(() => emitProgress(25))
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0.25')
    act(emitDownloaded)
    await advanceTime(1000)
    expect(screen.getByText('Restart')).toBeInTheDocument()
  })

  it('cleans up subscriptions and a pending completion timer on unmount', async () => {
    const view = renderToast()
    await advanceTime()
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    act(emitDownloaded)
    const timerIndex = setTimer.mock.calls.findIndex(([, delay]) => delay === 1000)
    expect(timerIndex).toBeGreaterThanOrEqual(0)
    const completionTimer = setTimer.mock.results[timerIndex].value
    view.unmount()

    expect(progressListeners.size).toBe(0)
    expect(downloadedListeners.size).toBe(0)
    expect(errorListeners.size).toBe(0)
    expect(clearTimer).toHaveBeenCalledWith(completionTimer)
    setTimer.mockRestore()
    clearTimer.mockRestore()
    await advanceTime(1000)
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
  })

  it('keeps a dismissed toast hidden when download events arrive', async () => {
    renderToast()
    await advanceTime()
    fireEvent.click(screen.getByLabelText('Close'))
    act(emitDownloaded)
    await advanceTime(1000)

    expect(screen.queryByText('Download finished')).not.toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'check-error', 'no-electron'])('retains manual download fallback (%s)', async (mode) => {
    if (mode === 'no-electron') delete window.electron
    updater.checkForUpdates.mockImplementation(async () => {
      if (mode === 'check-error') emitError(new Error('Check failed'))
      return undefined
    })
    renderToast()
    await advanceTime()

    expect(fetchRelease).toHaveBeenCalledExactlyOnceWith(links.latestReleaseApi)
    expect(screen.getByText('Version 3.3.3 is available')).toBeInTheDocument()
    expect(screen.queryByText('Download failed')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Download'))
    expect(openInWebBrowser).toHaveBeenCalledExactlyOnceWith(links.latestRelease)
    expect(updater.quitAndInstallUpdate).not.toHaveBeenCalled()
  })

  it('does not offer a newer release excluded by the updater eligibility checks', async () => {
    updater.checkForUpdates.mockResolvedValue({ version: '3.3.3', isUpdateAvailable: false })
    renderToast()
    await advanceTime()

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
    expect(screen.queryByText('Download')).not.toBeInTheDocument()
    expect(fetchRelease).not.toHaveBeenCalled()
    expect(updater.startUpdateDownload).not.toHaveBeenCalled()
  })

  it.each(['3.3.2', '3.3.1', '3.3.3-rc.1', 'invalid'])('does not offer an ineligible version (%s)', async (version) => {
    updater.checkForUpdates.mockResolvedValue({ version, isUpdateAvailable: true })
    renderToast()
    await advanceTime()

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
    expect(screen.queryByText('Download')).not.toBeInTheDocument()
    expect(fetchRelease).not.toHaveBeenCalled()
  })
})
