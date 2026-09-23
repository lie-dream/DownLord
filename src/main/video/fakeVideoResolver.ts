/**
 * FakeVideoResolver — dev 模拟视频解析器(仅 dev:fake,spec §4.5)。
 *
 * 与 FakeEngine 配套:无真 yt-dlp 时,让 `npm run dev:fake` 能端到端跑视频状态机
 * (resolving → awaiting_selection → … → completed)。实现 TaskManager 的 `VideoResolverLike`,
 * 据 url 关键字吐 mock `ResolvedVideo`(含若干 mock 格式)/ `ResolvedPlaylist`(N 条 entries)。
 *
 * **仅 dev 调试,不入打包默认路径**(沿用 Task 4 FakeEngine 红线):build / package 不设
 * `DOWNLORD_FAKE_ENGINE`,主进程不走 useFake 分支,本类不被实例化;真 yt-dlp 解析留真二进制(Task 9)。
 */
import type {
  CookieConfig,
  ProxyResolved,
  ResolvedFormat,
  ResolvedPlaylist,
  ResolvedVideo,
  ResolveResult
} from '../../shared/ipc'
import type { VideoResolverLike } from '../tasks/taskManager'

const MB = 1024 * 1024

/** mock 单视频可选格式:覆盖 video-only(需合音轨)/ muxed(含音频)/ 纯音频(供音频开关) */
const MOCK_FORMATS: ResolvedFormat[] = [
  {
    formatId: '137',
    ext: 'mp4',
    height: 1080,
    fps: 30,
    vcodec: 'avc1.640028',
    acodec: 'none', // 纯视频 → 选它触发 +bestaudio 合并(processing)
    filesize: 480 * MB,
    tbr: 4500,
    formatNote: '1080p'
  },
  {
    formatId: '22',
    ext: 'mp4',
    height: 720,
    fps: 30,
    vcodec: 'avc1.64001F',
    acodec: 'mp4a.40.2', // muxed 含音频 → 直接可用
    filesize: 180 * MB,
    tbr: 1500,
    formatNote: '720p'
  },
  {
    formatId: '18',
    ext: 'mp4',
    height: 360,
    fps: 30,
    vcodec: 'avc1.42001E',
    acodec: 'mp4a.40.2',
    filesize: 60 * MB,
    tbr: 600,
    formatNote: '360p'
  },
  {
    formatId: '140',
    ext: 'm4a',
    height: null,
    fps: null,
    vcodec: 'none', // 纯音频(formatList 会剔除;音频走开关)
    acodec: 'mp4a.40.2',
    filesize: 8 * MB,
    tbr: 128,
    formatNote: 'audio only'
  }
]

const PLAYLIST_ENTRY_COUNT = 5

/** 接同签名注入但 dev **忽略**代理 / cookie 值(不真正连网 / 不真读 cookie,spec §4.4 / §6.4);仅为与真实 VideoResolver 类型一致 */
export interface FakeVideoResolverDeps {
  getProxy?: () => ProxyResolved
  /** 同签名占位:dev 不真读浏览器 / 文件 cookie(仅类型对称,spec §6.4) */
  getCookie?: () => CookieConfig
}

export class FakeVideoResolver implements VideoResolverLike {
  // dev mock:接收同签名 deps 但忽略代理 / cookie(不真连网 / 不真读 cookie);_ 前缀豁免 noUnusedParameters
  constructor(_deps: FakeVideoResolverDeps = {}) {
    /* dev mock:刻意不保存 deps —— 不真连网 / 不真读 cookie,构造无副作用 */
  }

  /** dev mock:同步构造结果,忽略 AbortSignal(不支持取消;省略可选参,implements 仍兼容) */
  async resolve(url: string): Promise<ResolveResult> {
    if (/playlist/i.test(url)) {
      return this.mockPlaylist(url)
    }
    return this.mockVideo(url)
  }

  private mockVideo(url: string): ResolvedVideo {
    return {
      kind: 'video',
      id: this.slug(url),
      title: `Mock 视频 · ${this.slug(url)}`,
      durationSec: 215,
      thumbnail: null,
      extractor: 'mock',
      webpageUrl: url,
      formats: MOCK_FORMATS.map((format) => ({ ...format })),
      // dev mock 字幕轨(spec §6.4):zh-Hans 人工 + en 人工 + zh-Hans 自动(同 lang 人工/自动并存),
      // 供 Step 5 FormatDialog 字幕区可视化手测(勾选 / 自动标注),dev 不真下字幕。
      subtitles: [
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', auto: false },
        { lang: 'en', name: 'English', auto: false },
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', auto: true }
      ]
    }
  }

  private mockPlaylist(url: string): ResolvedPlaylist {
    const entries = Array.from({ length: PLAYLIST_ENTRY_COUNT }, (_unused, i) => {
      const n = i + 1
      return {
        id: `${this.slug(url)}-${n}`,
        title: `Mock 播放列表条目 ${n}`,
        // 子条目 url 含 video 关键字:Phase 5 批量提交后,子任务下载走 FakeEngine 视频后处理序列
        url: `http://x/playlist-video${n}`,
        durationSec: 120 + n * 30
      }
    })
    return {
      kind: 'playlist',
      title: `Mock 播放列表 · ${this.slug(url)}`,
      entries
    }
  }

  /** 取 url 末段作可读标识(无则兜底 'clip') */
  private slug(url: string): string {
    const tail = url.split(/[/?#]/).filter(Boolean).pop()
    return tail && tail.length > 0 ? tail : 'clip'
  }
}
