/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CategoryConfig, FormatChoice, ResolvedVideo } from '../../../shared/ipc'
import FormatDialog from './FormatDialog'

afterEach(cleanup)

const MB = 1024 * 1024

// category:list 下发解析后真实目录(跟随态:video→Videos / audio→Music)
const CATEGORIES: CategoryConfig[] = [
  {
    key: 'video',
    displayName: '视频',
    extensions: ['mp4'],
    savePath: 'D:/DL/Videos',
    isCustom: false
  },
  {
    key: 'audio',
    displayName: '音频',
    extensions: ['mp3'],
    savePath: 'D:/DL/Music',
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: 'D:/DL', isCustom: false }
]

const mockVideo: ResolvedVideo = {
  kind: 'video',
  id: 'v1',
  title: '挪威峡湾风光纪录片',
  durationSec: 215,
  thumbnail: null,
  extractor: 'youtube',
  webpageUrl: 'https://youtube.com/watch?v=v1',
  formats: [
    {
      formatId: '137',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'avc1.640028',
      acodec: 'none',
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
      acodec: 'mp4a.40.2',
      filesize: 180 * MB,
      tbr: 1500,
      formatNote: '720p'
    },
    {
      formatId: '140',
      ext: 'm4a',
      height: null,
      fps: null,
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      filesize: 8 * MB,
      tbr: 128,
      formatNote: 'audio only'
    }
  ],
  subtitles: []
}

test('open=false 时不渲染', () => {
  render(
    <FormatDialog
      open={false}
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  assert.equal(screen.queryByText('选择清晰度与格式'), null)
})

test('渲染标题 / 时长 / 来源 / 格式行', () => {
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  assert.ok(screen.getByText('挪威峡湾风光纪录片'))
  assert.ok(screen.getByText('3:35'))
  assert.ok(screen.getByText(/YouTube/))
  assert.ok(screen.getByText('1080P'))
  assert.ok(screen.getByText('720P'))
  // 纯音频项不进格式列表
  assert.equal(screen.queryByText('audio only'), null)
})

test('默认选中最高清晰度 → 开始下载提交该 formatId', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, { audioOnly: false, formatId: '137' })
})

test('点选 720P → 提交该 formatId', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  fireEvent.click(screen.getByText('720P'))
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, { audioOnly: false, formatId: '22' })
})

test('开音频开关 → 隐藏格式列表 + 提交 audioOnly', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  // 现存两个开关(音频 / 字幕),按无障碍名定位音频开关
  fireEvent.click(screen.getByRole('switch', { name: '仅下载音频转 MP3' }))
  // 格式列表隐藏
  assert.equal(screen.queryByText('1080P'), null)
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, { audioOnly: true })
})

test('点取消 / × 触发 onClose', () => {
  let closed = 0
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => (closed += 1)}
      onSubmit={() => {}}
    />
  )
  fireEvent.click(screen.getByText('取消'))
  fireEvent.click(screen.getByTitle('关闭'))
  assert.equal(closed, 2)
})

test('点遮罩不关闭(防误触)', () => {
  let closed = false
  const { container } = render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => (closed = true)}
      onSubmit={() => {}}
    />
  )
  fireEvent.click(container.querySelector('.overlay') as Element)
  assert.equal(closed, false)
})

test('保存到:跟随态显 video 类目录;开音频开关 → 切 audio 类目录(实时落点,spec §2.3)', () => {
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  const dir = (): string | null => document.querySelector('.save-to .st-dir')?.textContent ?? null
  assert.equal(dir(), 'D:/DL/Videos')
  fireEvent.click(screen.getByRole('switch', { name: '仅下载音频转 MP3' }))
  assert.equal(dir(), 'D:/DL/Music')
})

test('保存到:显式目录覆盖(添加时浏览过)→ 忽略 audioOnly 恒显该目录', () => {
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={'E:/Movies'}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  const dir = (): string | null => document.querySelector('.save-to .st-dir')?.textContent ?? null
  assert.equal(dir(), 'E:/Movies')
  fireEvent.click(screen.getByRole('switch', { name: '仅下载音频转 MP3' }))
  assert.equal(dir(), 'E:/Movies')
})

// ---- 字幕区(spec §5.1)----

const videoWithSubs: ResolvedVideo = {
  ...mockVideo,
  subtitles: [
    { lang: 'zh-Hans', name: '简体中文', auto: false },
    { lang: 'en', name: 'English', auto: false },
    { lang: 'zh-Hans', name: '简体中文', auto: true }
  ]
}

test('无可用字幕 → 字幕开关禁用 + 「该视频无可用字幕」提示', () => {
  render(
    <FormatDialog
      open
      video={mockVideo}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  const sw = screen.getByRole('switch', { name: '下载字幕' }) as HTMLButtonElement
  assert.equal(sw.disabled, true)
  assert.ok(screen.getByText('该视频无可用字幕'))
})

test('audioOnly 开启 → 隐藏整个字幕区', () => {
  render(
    <FormatDialog
      open
      video={videoWithSubs}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={() => {}}
    />
  )
  assert.ok(screen.getByRole('switch', { name: '下载字幕' }))
  fireEvent.click(screen.getByRole('switch', { name: '仅下载音频转 MP3' }))
  assert.equal(screen.queryByRole('switch', { name: '下载字幕' }), null, '仅音频时字幕区隐藏')
})

test('有字幕:开下载字幕 → 展开语言 / 格式;勾选中英 + VTT → 提交携带 subtitles', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={videoWithSubs}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  // 开下载字幕开关(默认偏好读不到 window.api → 初始关闭)
  fireEvent.click(screen.getByRole('switch', { name: '下载字幕' }))
  // 语言 chip:同 lang 人工 + 自动均渲染(auto 后缀「(自动)」)
  assert.ok(screen.getByText('English'))
  assert.ok(screen.getByText('简体中文(自动)'))
  // 勾选简体中文(人工)+ English
  fireEvent.click(screen.getByText('简体中文', { selector: '.chip' }))
  fireEvent.click(screen.getByText('English'))
  // 切 VTT
  fireEvent.click(screen.getByText('VTT'))
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, {
    audioOnly: false,
    formatId: '137',
    subtitles: { langs: ['zh-Hans', 'en'], format: 'vtt', includeAuto: false }
  })
})

test('开下载字幕但未选语言 → 提交不带 subtitles(langs 空 → 零附加)', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={videoWithSubs}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  fireEvent.click(screen.getByRole('switch', { name: '下载字幕' }))
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, { audioOnly: false, formatId: '137' })
})

test('含自动生成开关 → 提交 includeAuto:true', () => {
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={videoWithSubs}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  fireEvent.click(screen.getByRole('switch', { name: '下载字幕' }))
  fireEvent.click(screen.getByText('简体中文', { selector: '.chip' }))
  fireEvent.click(screen.getByRole('switch', { name: '含自动生成字幕' }))
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, {
    audioOnly: false,
    formatId: '137',
    subtitles: { langs: ['zh-Hans'], format: 'srt', includeAuto: true }
  })
})

test('默认字幕偏好初始化:命中当前视频可用语言的交集 → 开关默认开 + 预选', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getSettings: async () => ({
        defaultDir: '',
        maxConcurrent: 3,
        maxOverallLimitKBps: 0,
        useAria2cForVideo: true,
        video: {
          defaultHeight: null,
          defaultAudioOnly: false,
          // 偏好含 zh-Hans(视频有)+ ja(视频无)→ 仅 zh-Hans 命中交集
          subtitle: { langs: ['zh-Hans', 'ja'], format: 'vtt', includeAuto: true }
        },
        themeMode: 'system'
      })
    }
  })
  let got: FormatChoice | null = null
  render(
    <FormatDialog
      open
      video={videoWithSubs}
      categories={CATEGORIES}
      explicitDir={null}
      onClose={() => {}}
      onSubmit={(c) => (got = c)}
    />
  )
  // getSettings 异步解析后:下载字幕开关自动开(交集非空)
  const sw = (await screen.findByRole('switch', { name: '下载字幕' })) as HTMLButtonElement
  await waitFor(() => assert.equal(sw.getAttribute('aria-checked'), 'true'))
  fireEvent.click(screen.getByText('开始下载'))
  // 仅命中的 zh-Hans 预选;格式 / includeAuto 取默认偏好
  assert.deepEqual(got, {
    audioOnly: false,
    formatId: '137',
    subtitles: { langs: ['zh-Hans'], format: 'vtt', includeAuto: true }
  })
  // 清理,避免影响后续用例
  delete (window as unknown as { api?: unknown }).api
})
