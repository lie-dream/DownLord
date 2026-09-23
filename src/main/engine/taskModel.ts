import type {
  DesiredState as SharedDesiredState,
  DownloadStatus as SharedDownloadStatus,
  DownloadTask as SharedDownloadTask
} from '../../shared/ipc'

export type DownloadStatus = SharedDownloadStatus

export type DesiredState = SharedDesiredState

export interface DownloadTask extends SharedDownloadTask {}

export function mapAria2Status(rawStatus: string): DownloadStatus {
  switch (rawStatus) {
    case 'active':
      return 'downloading'
    case 'paused':
      return 'paused'
    case 'waiting':
      return 'queued'
    case 'complete':
      return 'completed'
    case 'error':
    case 'removed':
      return 'error'
    default:
      return 'error'
  }
}
