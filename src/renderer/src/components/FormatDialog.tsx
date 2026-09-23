/**
 * 视频格式选择对话框 — 1:1 复刻原型 #ov-format(line 686–715)。
 *
 * - 结构对照原型:.vinfo(缩略图 + 时长 + 标题 / 来源)+ .fmt-list(逐 .fmt 单选)+ .audio-opt(.switch 开关)。
 * - 数据来自 ResolvedVideo;格式行经 lib/formatList 纯函数整理(剔纯音频 / 降序 / 去重 / 大小估算)。
 * - 音频开关打开 → 隐藏格式单选(audioOnly 忽略画质);「开始下载」→ onSubmit({audioOnly, formatId})。
 * - 关闭:取消 / 右上角 × / Esc;点遮罩不关闭(防误触,沿用 AddTaskDialog)。
 * - 纯展示:仅经 props 回调通信,不含解析 / 下载逻辑;复用全局 .overlay/.dialog 骨架(AddTaskDialog.css)。
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  CategoryConfig,
  FormatChoice,
  ResolvedVideo,
  SubtitleChoice
} from '../../../shared/ipc'
import { DEFAULT_SUBTITLE_CHOICE } from '../../../shared/ipc'
import { buildFormatRows, extractorLabel } from '../lib/formatList'
import { landingDirForVideo } from '../lib/saveLocationView'
import { formatDuration } from '../lib/format'
import './controls.css'
import './FormatDialog.css'

interface Props {
  open: boolean
  video: ResolvedVideo | null
  /** 类别配置(category:list 下发解析后真实目录);随 audioOnly 算落点(spec §2.3) */
  categories: CategoryConfig[]
  /** 添加时是否显式选过目录(parentDir(savePath)!==defaultDir 时为该目录,否则 null);显式优先 */
  explicitDir: string | null
  onClose: () => void
  onSubmit: (choice: FormatChoice) => void
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export default function FormatDialog({
  open,
  video,
  categories,
  explicitDir,
  onClose,
  onSubmit
}: Props): React.JSX.Element | null {
  const rows = useMemo(() => (video ? buildFormatRows(video) : []), [video])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [audioOnly, setAudioOnly] = useState(false)
  // 字幕选择态(spec §5.1):是否下载 + 选中语言 + 目标格式 + 是否含自动生成
  const [downloadSubs, setDownloadSubs] = useState(false)
  const [subLangs, setSubLangs] = useState<string[]>([])
  const [subFormat, setSubFormat] = useState<'srt' | 'vtt'>('srt')
  const [includeAuto, setIncludeAuto] = useState(false)
  const hasSubs = (video?.subtitles.length ?? 0) > 0
  // 落点随 audioOnly 实时算:仅音频→audio 类目录 / 否则→video 类目录;显式优先(spec §2.3)。目录来自 category:list,渲染层不拼 join(§7.2)
  const landingDir = landingDirForVideo({ audioOnly, categories, explicitDir })

  // 每次打开 / 切换视频:重置为默认(最高清晰度 + 关闭音频开关)。
  // 用「渲染期调整 state」(React 官方 derived-state 模式)而非 useEffect:少一轮级联渲染,
  // 且避免打开瞬间先渲染出旧选中再跳默认。语义与原 effect 一致(open 或 rows 变化时,open 才重置)。
  const [prevKey, setPrevKey] = useState<{ open: boolean; rows: typeof rows } | null>(null)
  if (prevKey?.open !== open || prevKey?.rows !== rows) {
    setPrevKey({ open, rows })
    if (open) {
      setSelectedId(rows[0]?.formatId ?? null)
      setAudioOnly(false)
    }
  }

  // 字幕默认:按用户默认偏好(settings.video.subtitle)初始化,语言取「命中当前视频可用语言」的交集(spec §5.1)。
  // 默认偏好经 window.api.getSettings 读取(渲染层只读展示,不含业务);读不到 / 无 api → 退化为关闭(向后兼容)。
  useEffect(() => {
    if (!open || !video) return
    const avail = video.subtitles.map((t) => t.lang)
    const applyPref = (pref: SubtitleChoice): void => {
      const langs = pref.langs.filter((l) => avail.includes(l))
      setSubLangs(langs)
      setDownloadSubs(langs.length > 0)
      setSubFormat(pref.format)
      setIncludeAuto(pref.includeAuto)
    }
    const api = window.api
    if (!api?.getSettings) {
      applyPref(DEFAULT_SUBTITLE_CHOICE)
      return
    }
    let alive = true
    api
      .getSettings()
      .then((s) => {
        if (alive) applyPref(s.video.subtitle ?? DEFAULT_SUBTITLE_CHOICE)
      })
      .catch(() => {
        if (alive) applyPref(DEFAULT_SUBTITLE_CHOICE)
      })
    return () => {
      alive = false
    }
  }, [open, video])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !video) return null

  const canSubmit = audioOnly || selectedId !== null

  const toggleLang = (lang: string): void =>
    setSubLangs((cur) => (cur.includes(lang) ? cur.filter((l) => l !== lang) : [...cur, lang]))

  const submit = (): void => {
    const choice: FormatChoice = audioOnly
      ? { audioOnly: true }
      : { audioOnly: false, formatId: selectedId ?? undefined }
    // 字幕仅在「非仅音频 + 下载字幕开 + 选了语言」时携带,否则不带 subtitles 键(langs 空 → 零附加,零回归,spec §3.2)
    if (!audioOnly && downloadSubs && subLangs.length > 0) {
      choice.subtitles = { langs: subLangs, format: subFormat, includeAuto }
    }
    onSubmit(choice)
  }

  return (
    <div className="overlay show">
      <div className="dialog">
        <div className="dialog-head">
          <h3>选择清晰度与格式</h3>
          <button className="dialog-close" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          <div className="vinfo">
            <div className="vthumb">
              {video.thumbnail ? (
                <img src={video.thumbnail} alt="" />
              ) : (
                <div className="vplay">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
              )}
              {video.durationSec != null && (
                <span className="vdur">{formatDuration(video.durationSec)}</span>
              )}
            </div>
            <div className="vmeta">
              <div className="vtitle" title={video.title}>
                {video.title}
              </div>
              <div className="vfrom">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                {extractorLabel(video.extractor)}
              </div>
            </div>
          </div>

          {!audioOnly && (
            <>
              <div className="fmt-label">可选格式</div>
              <div className="fmt-list">
                {rows.length === 0 ? (
                  <div className="fmt-empty">无可用视频格式,可改用「仅下载音频」</div>
                ) : (
                  rows.map((row) => (
                    <div
                      key={row.formatId}
                      className={`fmt${row.formatId === selectedId ? ' sel' : ''}`}
                      onClick={() => setSelectedId(row.formatId)}
                    >
                      <div className="radio" />
                      <div className="f-res">{row.resLabel}</div>
                      <div className="f-info">{row.infoLabel}</div>
                      <div className="f-size">{row.sizeLabel}</div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          <div className="audio-opt">
            <div className="ao-text">
              <div className="ao-title">仅下载音频(转 MP3)</div>
              <div className="ao-desc">忽略画面,只提取音轨保存为 MP3</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={audioOnly}
              aria-label="仅下载音频转 MP3"
              className={`switch${audioOnly ? ' on' : ''}`}
              onClick={() => setAudioOnly((v) => !v)}
            />
          </div>

          {/* 字幕区(spec §5.1):仅音频时隐藏(音频提取不配字幕);无可用字幕 → 开关禁用 + 提示 */}
          {!audioOnly && (
            <div className="subtitle-opt">
              <div className="so-text">
                <div className="so-title">下载字幕</div>
                <div className="so-desc">
                  {hasSubs ? '下载视频自带或自动生成的字幕(SRT / VTT)' : '该视频无可用字幕'}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={downloadSubs}
                aria-label="下载字幕"
                disabled={!hasSubs}
                className={`switch${downloadSubs ? ' on' : ''}`}
                onClick={() => setDownloadSubs((v) => !v)}
              />
            </div>
          )}

          {!audioOnly && downloadSubs && hasSubs && (
            <div className="sub-expand">
              <div className="sub-langs">
                {video.subtitles.map((t, i) => (
                  <button
                    type="button"
                    key={`${t.lang}-${t.auto}-${i}`}
                    className={`chip${subLangs.includes(t.lang) ? ' active' : ''}`}
                    onClick={() => toggleLang(t.lang)}
                  >
                    {(t.name ?? t.lang) + (t.auto ? '(自动)' : '')}
                  </button>
                ))}
              </div>
              <div className="sub-format">
                {(['srt', 'vtt'] as const).map((f) => (
                  <button
                    type="button"
                    key={f}
                    className={`chip${subFormat === f ? ' active' : ''}`}
                    onClick={() => setSubFormat(f)}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="sub-auto">
                <span className="sub-auto-label">含自动生成字幕</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeAuto}
                  aria-label="含自动生成字幕"
                  className={`switch${includeAuto ? ' on' : ''}`}
                  onClick={() => setIncludeAuto((v) => !v)}
                />
              </div>
            </div>
          )}

          {/* 保存到:随 audioOnly 实时反映最终落点(诚实归类,spec §2.3);目录来自 category:list */}
          <div className="save-to">
            <span className="st-label">保存到</span>
            <span className="st-dir" title={landingDir}>
              {landingDir}
            </span>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            <svg {...svgProps}>
              <path d="M12 3v12" />
              <path d="m7 11 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            开始下载
          </button>
        </div>
      </div>
    </div>
  )
}
