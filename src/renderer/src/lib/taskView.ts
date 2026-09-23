import type { Task } from '../../../shared/ipc'
import type { TaskRowView } from './types'
import { formatBytes } from './format'
import { computeShareRatio } from './shareRatio'

/**
 * torrent 下载中副信息(spec §6.2):「已下 / 总 · N 节点」;0 速时可观测——
 * 已连接 N 节点(N>0)显「N 节点 · 等待数据…」、未连上(N=0)显「正在寻找节点…」,
 * 消除真机「分不清加载还是卡住」(2026-07-22)。connections 由富进度透传(undefined → 0)。
 */
function torrentDownloadingSub(task: Task): string {
  const peers = task.connections ?? 0
  if (task.speed <= 0) {
    return peers > 0 ? `${peers} 节点 · 等待数据…` : '正在寻找节点…'
  }
  const total = task.totalBytes ? formatBytes(task.totalBytes) : '未知'
  return `${formatBytes(task.downloadedBytes)} / ${total} · ${peers} 节点`
}

export function taskView(task: Task): TaskRowView {
  // 视频任务显示友好清晰度(Task 8.5 §3.3);直链 / 无 qualityLabel(待选占位)→ undefined 不显示
  const quality = task.kind === 'video' ? task.videoMeta?.qualityLabel : undefined
  switch (task.status) {
    case 'downloading':
      // torrent:副信息带 peers + 0 速可观测(中点文本,不改 sub 结构);速度仍 ↓ 下行(brand),actions 不变
      return task.kind === 'torrent'
        ? {
            iconCategory: 'file',
            sub: { kind: 'text', text: torrentDownloadingSub(task) },
            progress: 'determinate',
            meta: { kind: 'percent' },
            speedTone: 'brand',
            quality,
            actions: ['limit', 'pause', 'cancel']
          }
        : {
            iconCategory: 'file',
            sub: {
              kind: 'text',
              text: `${formatBytes(task.downloadedBytes)} / ${task.totalBytes ? formatBytes(task.totalBytes) : '未知'}`
            },
            progress: 'determinate',
            meta: { kind: 'percent' },
            speedTone: 'brand',
            quality,
            actions: ['limit', 'pause', 'cancel']
          }
    case 'paused':
      return {
        iconCategory: 'file',
        sub: { kind: 'text', text: '已暂停' },
        progress: 'paused',
        meta: { kind: 'percent' },
        speedTone: 'muted',
        quality,
        actions: ['limit', 'resume', 'cancel']
      }
    case 'queued':
      return {
        iconCategory: 'file',
        sub: { kind: 'text', text: '排队中 · 等待空闲下载位' },
        progress: 'none',
        meta: { kind: 'pill', pillText: '排队中', pillKind: 'wait' },
        speedTone: 'none',
        quality,
        actions: ['cancel']
      }
    case 'completed':
      // torrent 做种中(v0.3 Task 3 · spec §6.2):持久化仍 completed,seeding 为运行时态。
      // meta 位「做种中」pill(seed)+ ↑ 上行(upload)+ 副信息「分享率 r · N 节点」(中点文本);
      // 操作前部加「停止做种」(中性,非 danger,保留文件),其后仍打开文件 / 文件夹 / 更多。诚实措辞无「加速他人」。
      if (task.kind === 'torrent' && task.seeding) {
        // 分享率 = 累计上传 / 已下(做种时 = 总字节);uploadLength / downloadedBytes 均由富进度帧带入
        const r = computeShareRatio(task.uploadLength ?? 0, task.totalBytes || task.downloadedBytes)
        // 「N 节点」用 connections(已连接对等节点总数,与下载中一致、含可能向你下载的 leecher):
        // 对做种者比 numSeeders(仅做种者数)更诚实——「已连上但无人拉取」不会误显 0(真机反馈 2026-07-26)
        return {
          iconCategory: 'file',
          sub: { kind: 'text', text: `分享率 ${r.toFixed(2)} · ${task.connections ?? 0} 节点` },
          progress: 'none',
          meta: { kind: 'pill', pillText: '做种中', pillKind: 'seed' },
          speedTone: 'upload',
          quality,
          actions: ['stopSeed', 'openFile', 'showInFolder', 'more']
        }
      }
      return {
        iconCategory: 'file',
        sub: {
          kind: 'ok',
          text: `已完成 · ${formatBytes(task.totalBytes || task.downloadedBytes)}`
        },
        progress: 'none',
        meta: { kind: 'percent' },
        speedTone: 'none',
        quality,
        actions: ['openFile', 'showInFolder', 'more']
      }
    case 'error':
      return {
        iconCategory: 'error',
        sub: { kind: 'err', text: task.error ?? '下载失败' },
        progress: 'none',
        meta: { kind: 'none' },
        speedTone: 'none',
        quality,
        actions: ['retry', 'cancel']
      }
    case 'resolving':
      // torrent 元数据阶段与 video 解析区分(v0.3 Task 1):BT 显「获取种子元数据中」、图标用文件(非视频);
      // 磁力可能是任意内容,不预判为视频。video 维持既有「正在解析链接…」+ 视频图标零回归。
      return task.kind === 'torrent'
        ? {
            iconCategory: 'file',
            sub: { kind: 'text', text: '正在获取种子元数据…' },
            progress: 'indeterminate',
            meta: { kind: 'none' },
            speedTone: 'none',
            quality,
            actions: ['cancel']
          }
        : {
            iconCategory: 'video',
            sub: { kind: 'text', text: '正在解析链接…' },
            progress: 'indeterminate',
            meta: { kind: 'none' },
            speedTone: 'none',
            quality,
            actions: ['cancel']
          }
    case 'awaiting_selection':
      // torrent 待选文件与 video 待选清晰度区分(v0.3 Task 2):BT 显「已获取种子信息,待选择文件」+ 文件图标;
      // 「选择文件」按钮文案由 TaskRow 按 kind 渲染(复用 selectFormat 动作,打开 BtFileDialog)。video 零回归。
      return task.kind === 'torrent'
        ? {
            iconCategory: 'file',
            sub: { kind: 'warn', text: '已获取种子信息,待选择文件' },
            progress: 'none',
            meta: { kind: 'none' },
            speedTone: 'none',
            quality,
            actions: ['selectFormat', 'cancel']
          }
        : {
            iconCategory: 'video',
            sub: { kind: 'warn', text: '已解析,待选择清晰度' },
            progress: 'none',
            meta: { kind: 'none' },
            speedTone: 'none',
            quality,
            actions: ['selectFormat', 'cancel']
          }
    case 'processing':
      return {
        iconCategory: 'video',
        sub: { kind: 'warn', text: '正在合并音视频…' },
        progress: 'processing',
        meta: { kind: 'none' },
        speedTone: 'warning',
        quality,
        actions: ['cancel']
      }
  }
}
