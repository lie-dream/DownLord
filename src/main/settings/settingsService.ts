/**
 * SettingsService — 主进程通用设置业务单元(Task 8 · spec §3.4)。
 *
 * 类比 `ProxyService` 的装配与自包含风格:启动读盘缓存全量 `AppSettings`,经同步 `get()`
 * 供注入回调(装配为 `getVideoPrefs: () => settingsService.get().video`)即时取用;`set(patch)`
 * 合并校验 → 原子写盘 → 触发 `onChange` 联动(并发 / 默认目录 / 主题即时生效)→ 回最新全量。
 *
 * 职责(spec §3.4):
 * 1. `init()` 读 `settings.json`(经 `readSettings`,缺失 / JSON 损坏 / 结构非法回退默认并修复)→ 缓存;
 *    空 `defaultDir` 解析为 `systemDownloadsDir`(运行时回落系统下载目录,spec §3.2;set 时随 merged 持久化绝对路径)。
 * 2. `get()` 同步取当前全量副本(供 IPC 回显 + getVideoPrefs 注入回调实时读)。
 * 3. `set(patch)` 合并校验(mergeSettings:已知键 / 越界 clamp / 白名单回退)→ 原子写(writeSettings)
 *    → onChange(联动)→ 回最新全量(clamp 后真实值)。
 *
 * 校验 / 持久化 / 联动**全在本服务**(ARCHITECTURE §7.2);渲染层不参与,IPC handler 纯转发。
 * 依赖全可注入(`store` / `configPath` / `systemDownloadsDir` / `onChange`),核心校验 / 合并是纯函数,
 * 单测注入 fake 不碰真实 FS / Electron / TaskManager。
 */
import { DEFAULT_APP_SETTINGS, type AppSettings, type AppSettingsPatch } from '../../shared/ipc'
import { isNetscapeCookieText } from './cookieFileFormat'
import { readSettings, writeSettings, type SettingsStoreFs } from './settingsStore'
import { mergeSettings } from './validateSettings'

export interface SettingsServiceDeps {
  /** settings.json 落盘 fs(真实传 nodeSettingsStoreFs;测试注入内存 fake) */
  store: SettingsStoreFs
  /** settings.json 绝对路径(`<userData>/config/settings.json`) */
  configPath: string
  /** 系统下载目录(`app.getPath('downloads')`);空 defaultDir 解析回落于此(spec §3.4) */
  systemDownloadsDir: string
  /**
   * 配置变更联动回调(spec §3.4):`set` 写盘后调用,传最新全量 `AppSettings`。
   * 真实装配接 `index.ts` 闭包(setMaxConcurrent / setDefaultDir / nativeTheme.themeSource);
   * 仿 `ProxyService.onStatusChanged` 注入缝,本服务不直接依赖 TaskManager / Electron。
   */
  onChange: (settings: AppSettings) => void
}

export class SettingsService {
  /** 缓存的全量设置(init / set 后即当前态;defaultDir 已解析为绝对路径) */
  private settings: AppSettings = cloneSettings(DEFAULT_APP_SETTINGS)

  /**
   * `set` 串行化队列:`set` 是「读缓存 → merge → await 写盘 → 更新缓存」的异步读改写,
   * 并发调用(设置页多控件 + 主题切换都写 settings)交错时,后者以未含前者补丁的旧缓存
   * merge 会丢更新;两次写还共享同一 `${path}.tmp`,交错 rename 会 ENOENT。排队后逐一执行,
   * 顺序调用行为逐字节不变。
   */
  private setQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SettingsServiceDeps) {}

  /**
   * 启动装配:读 settings.json 缓存(缺失 / 损坏回退默认并修复);
   * 空 `defaultDir` 解析为系统下载目录(spec §3.2 / §3.4「首启写入解析后的绝对路径」——
   * 内存即解析,后续首个 `set` 随 merged 持久化绝对路径)。
   */
  async init(): Promise<void> {
    const loaded = await readSettings(this.deps.configPath, this.deps.store)
    this.settings = {
      ...loaded,
      // 空串 = 用系统 downloads:解析为绝对路径,供路由 / 引擎兜底即时可用(spec §3.2)
      defaultDir: loaded.defaultDir || this.deps.systemDownloadsDir,
      video: { ...loaded.video }
    }
  }

  /** 同步取当前全量设置副本(spec §3.3 `settings:get`);返回副本避免调用方改写内部缓存 */
  get(): AppSettings {
    return cloneSettings(this.settings)
  }

  /**
   * 写设置补丁(spec §3.4 `settings:set`):合并校验 → 原子写盘 → 触发 onChange 联动 → 回最新全量。
   *
   * `mergeSettings` 仅接受已知键、逐字段校验(maxConcurrent 越界 clamp / defaultHeight 白名单回退 /
   * themeMode 守卫)。先 `await writeSettings` 原子落盘(失败抛给调用方,IPC 层冒泡;内存态不前移,
   * 保持与磁盘一致),成功后更新缓存并 `onChange(next)` 即时联动(并发出队补足 / 默认目录兜底 / 主题)。
   * video 不在 onChange 单独推送 —— getVideoPrefs 注入回调每次解析实时读 `get().video`(spec §3.4)。
   * @returns 校验 + clamp 后的最新全量(供渲染层回显真实值)
   */
  async set(patch: AppSettingsPatch): Promise<AppSettings> {
    const run = this.setQueue.then(() => this.doSet(patch))
    // 队尾吞错:前一个 set 失败不卡死后续 set;错误本身仍经 run 抛给本次调用方(IPC 冒泡)
    this.setQueue = run.catch(() => undefined)
    return run
  }

  private async doSet(patch: AppSettingsPatch): Promise<AppSettings> {
    const next = await this.rejectInvalidCookieFile(mergeSettings(this.settings, patch))
    await writeSettings(this.deps.configPath, next, this.deps.store)
    this.settings = next
    // 默认目录变化无需「同步分类目录」:resolveCategoryDir 按当前 defaultDir 实时解析,未自定义类别
    // 下一次路由即跟随新目录(spec §1.3 / §1.4,取代并移除 C2)。onChange 内 setDefaultDir 驱动该联动。
    this.deps.onChange(this.get())
    return this.get()
  }

  /**
   * 第三档 cookie 文件的**格式校验**(v1.0 Task 3 · `M-015`)—— 非 Netscape 格式**不落盘**。
   *
   * 存在理由:选一个 `.jpg` 也照收,用户要等到下载失败、拿到一个指向别处的错误码才知道选错了
   * (v1.0 Task 2 手测 N08)。校验放这里而不是渲染层,是因为 ARCHITECTURE §7.2 ——
   * 渲染层连「字符串转数字」都不当成校验;它只看回包里的路径还在不在,据此显示提示。
   *
   * 三条边界:
   * 1. **只在文件真换了时读盘** —— 改别的设置(主题 / 并发)不该顺带去读一遍 cookie 文件;
   * 2. **读不到一律放行** —— 「读不到」既可能是路径错,也可能是 U 盘没插 / 权限不足,
   *    拿不准就不替用户下结论(下载时 `COOKIE_FILE_INVALID` 仍然兜底);
   * 3. **只把 `file` 置空,不动 `source`** —— 用户选的档位是他的意愿,别顺手改掉;
   *    第三档 + 空路径本就是合法的「还没选文件」态(既有 UI 已有该分支)。
   */
  private async rejectInvalidCookieFile(next: AppSettings): Promise<AppSettings> {
    const cookie = next.video.cookie
    const file = cookie?.file
    if (!cookie || cookie.source !== 'file' || !file) return next
    if (file === this.settings.video.cookie?.file) return next
    let text: string
    try {
      text = await this.deps.store.readFile(file)
    } catch {
      return next
    }
    if (isNetscapeCookieText(text)) return next
    return { ...next, video: { ...next.video, cookie: { ...cookie, file: null } } }
  }
}

/** 深拷贝设置(含嵌套 video),避免共享引用被调用方改写内部缓存 */
function cloneSettings(settings: AppSettings): AppSettings {
  return { ...settings, video: { ...settings.video } }
}
