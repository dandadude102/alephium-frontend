import { AnalyticsEvent } from '@alephium/shared'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import Button from '@/components/Button'
import useAnalytics from '@/features/analytics/useAnalytics'
import useLatestGitHubRelease from '@/features/autoUpdate/useLatestGitHubRelease'
import ToastBox from '@/features/toastMessages/ToastBox'
import { currentVersion } from '@/utils/app-data'
import { links } from '@/utils/links'
import { openInWebBrowser } from '@/utils/misc'

const AutoUpdateToastBox = memo(() => {
  const { t } = useTranslation()
  const { newAutoUpdateVersion, newManualUpdateVersion, autoUpdateStatus, downloadPercent, downloadError } =
    useLatestGitHubRelease()
  const { sendAnalytics } = useAnalytics()

  const [isUpdateSnackbarVisible, setIsUpdateSnackbarVisible] = useState(true)
  const status = newAutoUpdateVersion ? autoUpdateStatus : 'download-available'
  const error = newAutoUpdateVersion ? downloadError : ''

  const newVersion = newAutoUpdateVersion || newManualUpdateVersion

  if (!newVersion || !isUpdateSnackbarVisible) return null

  const handleManualDownloadClick = () => {
    openInWebBrowser(links.latestRelease)
    closeSnackbar()
    sendAnalytics({
      event: AnalyticsEvent.AUTO_UPDATE_MODAL_CLICKED_DOWNLOAD,
      props: { from_version: currentVersion, to_version: newManualUpdateVersion }
    })
  }

  const handleRestartClick = () => {
    sendAnalytics({ event: AnalyticsEvent.AUTO_UPDATE_MODAL_CLICKED_RESTART })
    window.electron?.updater.quitAndInstallUpdate()
  }

  const closeSnackbar = () => {
    setIsUpdateSnackbarVisible(false)
    sendAnalytics({ event: AnalyticsEvent.AUTO_UPDATE_MODAL_CLOSED })
  }

  const downloadTitle = {
    'download-available': t('Version {{ newVersion }} is available', { newVersion }),
    'download-finished': t('Download finished'),
    'download-failed': t('Download failed'),
    downloading: t('Downloading version {{ newVersion }}...', { newVersion })
  }[status]

  const downloadMessage = {
    'download-available': t('Please, download it and install it to avoid any issues with the wallet.'),
    'download-finished': t('Restart the application to install the new update.'),
    'download-failed': t('Try again later.'),
    downloading: ''
  }[status]

  return (
    <ToastBox
      type={error ? 'error' : status === 'download-finished' ? 'success' : 'info'}
      onClose={closeSnackbar}
      title={downloadTitle}
      FooterButtons={
        <>
          {status === 'download-available' && newManualUpdateVersion && (
            <Button wide squared onClick={handleManualDownloadClick}>
              {t('Download')}
            </Button>
          )}
          {status === 'download-finished' && !error && (
            <Button wide squared role="secondary" onClick={handleRestartClick}>
              {t('Restart')}
            </Button>
          )}
        </>
      }
    >
      <Texts>
        <div>{error ? error : downloadMessage}</div>
        {status === 'downloading' && <ProgressBar value={downloadPercent / 100} />}
      </Texts>
    </ToastBox>
  )
})

export default AutoUpdateToastBox

const Texts = styled.div`
  flex: 1;
`

const ProgressBar = styled.progress`
  width: 100%;
`
