/**
 * 链接识别卡视图描述(纯函数,spec §8.2)。
 *
 * 包 `classifyLink`(主进程纯启发式)→ 添加对话框「识别卡」文案 / 来源友好名 / 建议 kind。
 * 可选 `knownFileExts`(运行时类别 extensions)透传 classifyLink,加固带已知文件扩展名直链判 http(spec §6.3)。
 * **仅给默认建议**,yt-dlp 才是解析权威;不起子进程、不碰网络、不含业务逻辑。
 */

import { classifyLink, type LinkKind } from '../../../main/video/linkClassify'

export interface LinkDescription {
  /** 启发式判定结果 */
  kind: LinkKind
  /** 提交建议(ambiguous → 默认按 video,PRD §5;torrent 由 addTorrent 直投,不参与 video/http 选择) */
  suggestedKind: 'video' | 'http'
  /** 视频站点友好名(kind=video 时有) */
  siteLabel?: string
  /** 识别卡标题 */
  title: string
  /** 识别卡副文案 */
  sub: string
}

export function describeLink(url: string, knownFileExts?: ReadonlySet<string>): LinkDescription {
  const { kind, siteLabel } = classifyLink(url, knownFileExts)

  // torrent(v0.3 Task 1 · spec §10.3):magnet → aria2 原生 BT 整包;远程 `.torrent` URL → aria2 原生 BT
  // 需本地种子内容,远程 URL 只能按直链下载该 `.torrent` 文件本身(本地种子请用「选择种子文件」按钮)。
  // suggestedKind='http' 仅占位:magnet 由对话框 addTorrent 直投、`.torrent` URL 走直链,均不经 video/http select。
  if (kind === 'torrent') {
    if (url.startsWith('magnet:')) {
      return {
        kind,
        suggestedKind: 'http',
        title: '识别为磁力链接',
        sub: '将用 aria2 原生 BT 能力下载整包内容'
      }
    }
    return {
      kind,
      suggestedKind: 'http',
      title: '识别为种子文件链接',
      sub: '将作为普通文件下载该 .torrent(本地种子请用「选择种子文件」)'
    }
  }

  if (kind === 'video') {
    return {
      kind,
      suggestedKind: 'video',
      siteLabel,
      title: `识别为视频链接 · 来源 ${siteLabel ?? '未知'}`,
      sub: '将用 yt-dlp 解析可选清晰度'
    }
  }

  if (kind === 'http') {
    return {
      kind,
      suggestedKind: 'http',
      title: '识别为直链下载',
      sub: '将作为普通文件直接下载'
    }
  }

  // ambiguous:普通网页 / 未知站 → 默认尝试视频解析(用户可切直链)
  return {
    kind,
    suggestedKind: 'video',
    title: '未知链接,将尝试视频解析',
    sub: '无法确定类型,默认按视频解析(可切换为直链下载)'
  }
}
