import { exponentialBackoffFetchRetry } from '@alephium/shared/api'
import { compareVersions } from 'compare-versions'
import { useEffect, useRef, useState } from 'react'

import useAnalytics from '@/features/analytics/useAnalytics'
import useThrottledGitHubApi from '@/hooks/useThrottledGitHubApi'
import { currentVersion, isRcVersion } from '@/utils/app-data'
import { links } from '@/utils/links'

const semverRegex = isRcVersion ? /^(\d+\.\d+\.\d+)(?:-rc(\.\d+)?)?$/ : /^(\d+\.\d+\.\d+)?$/

type AutoUpdateStatus = 'downloading' | 'download-finished' | 'download-failed'

const useLatestGitHubRelease = () => {
  const { sendAnalytics } = useAnalytics()

  const [newAutoUpdateVersion, setNewAutoUpdateVersion] = useState('')
  const [newManualUpdateVersion, setNewManualUpdateVersion] = useState('')

  const [autoUpdateStatus, setAutoUpdateStatus] = useState<AutoUpdateStatus>('downloading')
  const [downloadPercent, setDownloadPercent] = useState(0)
  const [downloadError, setDownloadError] = useState('')
  const downloadFinishedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const downloadEventCount = useRef(0)

  // Auto-download can emit events before checkForUpdates resolves, including for a cached update.
  // Subscribe before useThrottledGitHubApi starts the check, even before a new version is known.
  useEffect(() => {
    const removeProgressListener = window.electron?.updater.onUpdateDownloadProgress((info) => {
      downloadEventCount.current += 1
      setAutoUpdateStatus('downloading')
      setDownloadPercent(info.percent)
      setDownloadError('')
    })
    const removeDownloadedListener = window.electron?.updater.onUpdateDownloaded(() => {
      downloadEventCount.current += 1
      // Preserve the existing delay for download validation errors, but never overwrite a failure.
      clearTimeout(downloadFinishedTimer.current)
      downloadFinishedTimer.current = setTimeout(
        () => setAutoUpdateStatus((status) => (status === 'download-failed' ? status : 'download-finished')),
        1000
      )
    })
    const removeErrorListener = window.electron?.updater.onError((error) => {
      downloadEventCount.current += 1
      clearTimeout(downloadFinishedTimer.current)
      setAutoUpdateStatus('download-failed')
      setDownloadError(error.toString())
      sendAnalytics({ type: 'error', error, message: 'Auto-update download failed' })
    })

    return () => {
      removeProgressListener?.()
      removeDownloadedListener?.()
      removeErrorListener?.()
      clearTimeout(downloadFinishedTimer.current)
    }
  }, [sendAnalytics])

  const checkForManualDownload = async () => {
    try {
      const response = await exponentialBackoffFetchRetry(links.latestReleaseApi)
      const data = await response.json()
      const version = data?.tag_name?.replace('alephium-desktop-wallet@', '')

      if (version && isVersionNewer(version)) {
        setNewManualUpdateVersion(version)
      }
    } catch (error) {
      sendAnalytics({ type: 'error', error, message: 'Checking for latest release version for manual download' })
    }
  }

  useThrottledGitHubApi({
    lastGithubCallTimestampKey: 'lastTimeGitHubApiWasCalledForLatestVersion',
    githubApiCallback: async () => {
      const eventsBeforeCheck = downloadEventCount.current

      if (autoUpdateStatus === 'download-failed') {
        clearTimeout(downloadFinishedTimer.current)
        setAutoUpdateStatus('downloading')
        setDownloadPercent(0)
        setDownloadError('')
      }

      const result = await window.electron?.updater.checkForUpdates()

      if (
        autoUpdateStatus === 'download-failed' &&
        !result?.isUpdateAvailable &&
        downloadEventCount.current === eventsBeforeCheck
      ) {
        setAutoUpdateStatus('download-failed')
        setDownloadError(downloadError)
      }

      if (!result) {
        await checkForManualDownload()
      } else if (result.isUpdateAvailable && isVersionNewer(result.version)) {
        const { version } = result

        // A new download may not have emitted an event yet. Otherwise, keep its latest state,
        // including completion or failure received before this check's response.
        if (version !== newAutoUpdateVersion && downloadEventCount.current === eventsBeforeCheck) {
          clearTimeout(downloadFinishedTimer.current)
          setAutoUpdateStatus('downloading')
          setDownloadPercent(0)
          setDownloadError('')
        }
        setNewAutoUpdateVersion(version)
      }
    }
  })

  return {
    newAutoUpdateVersion,
    newManualUpdateVersion,
    autoUpdateStatus,
    downloadPercent,
    downloadError
  }
}

export default useLatestGitHubRelease

const isVersionNewer = (version: string): boolean =>
  semverRegex.test(version) && !!currentVersion && compareVersions(version, currentVersion) > 0
