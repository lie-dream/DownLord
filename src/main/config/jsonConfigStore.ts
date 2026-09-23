/**
 * json 配置存储泛型(v0.4 Task 3 · spec §1.4 / §1.4.1)。
 *
 * 全仓四份手写同形 store(`proxyStore` / `settingsStore` / `updateStateStore` / `btTrackerStore`)
 * 的**写路径逐字相同**(`mkdir(dirname)` → 写 `${path}.tmp` → `rename`,内容 `JSON.stringify(v, null, 2)`,
 * 无尾换行),差异**恰好只落在三个轴上**:
 *
 * | 轴 | 选项 | 两端取值 |
 * |---|---|---|
 * | 损坏时是否回写默认修复 | `repairOnInvalid` | 用户配置 ✅ 修复 / 派生缓存 ❌ 不修复(下次写入自愈) |
 * | 合法结构的规整方式 | `normalize` | 取显式字段 / `{...DEFAULT, ...parsed}` / `mergeSettings`(clamp) |
 * | 默认值副本 | `cloneDefaults` | 浅展开 / 含数组需多一层 |
 *
 * 本文件是这三个轴的唯一权威;各 store 保留原导出名与签名,内部委托这里(调用点零改动)。
 * fs 经接口注入(测试注入内存 fake),本模块不 import `fs`。
 */
import { dirname } from 'node:path'

/** 注入式 fs 接口(原子写所需最小面:read / write / rename / mkdir) */
export interface JsonConfigStoreFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  mkdir(dir: string): Promise<void>
}

export interface JsonConfigStoreOptions<T> {
  /** 落点绝对路径(如 `<userData>/config/settings.json`) */
  path: string
  fs: JsonConfigStoreFs
  /**
   * 默认值的**独立副本**工厂 —— 用工厂而非 `defaults` 常量:含数组 / 嵌套对象的默认值浅展开会让
   * 调用方共享同一份引用,一旦被 mutate 就污染全局常量(`../bt/btTrackerStore.ts` 的
   * `cloneDefaultCache` 注释已记过这个坑)。
   */
  cloneDefaults: () => T
  /** 结构守卫(只判结构,不判取值范围 —— 范围归 `normalize`) */
  guard: (v: unknown) => v is T
  /** 合法结构的规整:取显式字段 / 补默认 / clamp。缺省 = 原样返回 */
  normalize?: (parsed: T) => T
  /**
   * 缺失 / 损坏 / 结构非法时是否回写默认修复(尽力而为,**失败不抛**)。
   * **默认 `false`** —— 派生缓存不重写,损坏文件原样留着,下次成功写入自愈。
   */
  repairOnInvalid?: boolean
}

/** 读写门面(编排层经此读写,单测可注入内存 fake) */
export interface JsonConfigStore<T> {
  read(): Promise<T>
  write(value: T): Promise<void>
}

/**
 * 组装 json 配置读写门面:
 * - 写:**原子写**(先 `mkdir` 父目录 → 写 `${path}.tmp` → `rename` 覆盖),避免半写损坏。
 * - 读:缺失 / JSON 损坏 / 结构非法 → 回退 `cloneDefaults()`;`repairOnInvalid` 为真时另回写默认修复
 *   (修复写失败不抛,仍返回默认值 —— 不因可恢复的配置损坏而崩溃)。
 * - 结构合法 → 经 `normalize` 归一后返回,**不触发修复重写**。
 */
export function createJsonConfigStore<T>(options: JsonConfigStoreOptions<T>): JsonConfigStore<T> {
  const { path, fs, cloneDefaults, guard, normalize, repairOnInvalid = false } = options

  async function write(value: T): Promise<void> {
    await fs.mkdir(dirname(path))
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value, null, 2))
    await fs.rename(tmp, path)
  }

  async function read(): Promise<T> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path))
      if (guard(parsed)) {
        return normalize ? normalize(parsed) : parsed
      }
    } catch {
      // 缺失 / 损坏 → 落到下方回退
    }

    const defaults = cloneDefaults()
    if (repairOnInvalid) {
      try {
        await write(defaults)
      } catch {
        // 修复写失败(如目录只读)不影响返回默认值,运行期仍可用
      }
    }
    return defaults
  }

  return { read, write }
}
