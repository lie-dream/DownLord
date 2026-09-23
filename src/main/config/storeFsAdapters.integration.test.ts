/**
 * L3 · fs 边界适配器的真实行为与降级契约 —— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L3 层)。
 *
 * 被测对象是三个**结构完全同形**的薄封装(此前逐个零覆盖):
 *   · `bt/nodeBtTrackerStoreFs.ts`      (BtTrackerStoreFs)
 *   · `extensionChannel/nodeChannelStoreFs.ts`(JsonConfigStoreFs)
 *   · `proxy/proxyStoreFs.ts`           (ProxyStoreFs)
 *
 * 为什么值得测(它们只有四行):`createJsonConfigStore` 的「缺失 / 损坏 → 回退默认值」整条降级路径,
 * **靠的正是 `readFile` 在文件不存在时 reject**(store 那侧是个光秃秃的 `catch {}`)。
 * 哪天有人把 `readFile` 改成「读不到就返回空串」,store 会拿 `JSON.parse('')` 抛错、照样回退默认值 ——
 * 行为看着一样,但**首次运行与配置损坏就再也分不开了**,而且没有任何一条既有断言会红。
 *
 * 三个放一个文件测,是因为「同形」这件事本身就是被测性质:逐条对三者跑同一组断言,
 * 谁哪天偷偷长歪了(比如漏掉 `recursive: true`、或 writeFile 丢了 utf-8)当场露出来。
 *
 * 形态:真实 fs + tmpdir 夹具(`tests/helpers/tmpdir.ts`),不 mock —— mock fs 测 fs 封装等于什么都没测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile as realReadFile, writeFile as realWriteFile, stat } from 'node:fs/promises'
import * as path from 'path'

import { makeTempDir } from '../../../tests/helpers/tmpdir'
import { nodeBtTrackerStoreFs } from '../bt/nodeBtTrackerStoreFs'
import { nodeChannelStoreFs } from '../extensionChannel/nodeChannelStoreFs'
import { nodeProxyStoreFs } from '../proxy/proxyStoreFs'

/** 三个适配器的最小公共面(BtTrackerStoreFs / JsonConfigStoreFs / ProxyStoreFs 逐字相同) */
interface StoreFs {
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  mkdir(dir: string): Promise<void>
}

const ADAPTERS: Array<[string, StoreFs]> = [
  ['nodeBtTrackerStoreFs', nodeBtTrackerStoreFs],
  ['nodeChannelStoreFs', nodeChannelStoreFs],
  ['nodeProxyStoreFs', nodeProxyStoreFs]
]

/** 含中文 + emoji + 换行:utf-8 丢了当场看得见(Buffer / latin1 都过不了这一条) */
const SAMPLE = '{\n  "trackers": ["udp://兔子.example:6969"],\n  "note": "中文 🐇"\n}'

for (const [name, fs] of ADAPTERS) {
  test(`L3-fs-1 ${name}:writeFile → readFile 往返按 utf-8 还原(返回 string 而非 Buffer)`, async (t) => {
    const dir = await makeTempDir(t, 'storefs')
    const file = path.join(dir, 'cfg.json')
    await fs.writeFile(file, SAMPLE)

    const back = await fs.readFile(file)
    assert.equal(typeof back, 'string', 'readFile 必须回 string —— 回 Buffer 会让 JSON.parse 在别处才炸')
    assert.equal(back, SAMPLE, '中文 / emoji / 换行必须逐字还原')
    // 再用「不带编码」的原生 readFile 交叉核对:落盘的确实是 utf-8 字节,不是别的编码
    const raw = await realReadFile(file)
    assert.equal(raw.toString('utf-8'), SAMPLE)
  })

  test(`L3-fs-2 ${name}:readFile 读不存在的文件必须 reject(ENOENT),不许静默回空串`, async (t) => {
    const dir = await makeTempDir(t, 'storefs')
    const missing = path.join(dir, 'never-written.json')

    await assert.rejects(
      () => fs.readFile(missing),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, 'ENOENT', `期望 ENOENT,实得 ${String(err.code)}`)
        return true
      },
      'createJsonConfigStore 的「首次运行 → 回退默认值」整条路就架在这次 reject 上'
    )

    // 正向对照:同一个适配器读**确实存在**的文件时不 reject —— 否则上一条在「readFile 恒抛」时也绿
    await fs.writeFile(missing, 'ok')
    assert.equal(await fs.readFile(missing), 'ok')
  })

  test(`L3-fs-3 ${name}:mkdir 递归建多级目录,且对已存在目录幂等(不抛 EEXIST)`, async (t) => {
    const dir = await makeTempDir(t, 'storefs')
    const deep = path.join(dir, 'config', 'nested', 'more')

    await fs.mkdir(deep)
    assert.equal((await stat(deep)).isDirectory(), true, 'recursive:true 必须一次建出多级')

    // 幂等:配置每次写盘前都会 mkdir 一次,不幂等就是每次第二笔写都炸
    await fs.mkdir(deep)
    assert.equal((await stat(deep)).isDirectory(), true)
  })

  test(`L3-fs-4 ${name}:rename 覆盖已存在的目标(原子写 tmp → 正式名的最后一步)`, async (t) => {
    const dir = await makeTempDir(t, 'storefs')
    const target = path.join(dir, 'cfg.json')
    const tmp = `${target}.tmp`
    await realWriteFile(target, 'OLD', 'utf-8')
    await realWriteFile(tmp, 'NEW', 'utf-8')

    await fs.rename(tmp, target)

    assert.equal(await fs.readFile(target), 'NEW', 'rename 必须覆盖旧文件(否则原子写第二次就失效)')
    await assert.rejects(() => fs.readFile(tmp), 'tmp 必须被搬走,不能留下残骸')
  })

  test(`L3-fs-5 ${name}:写进不存在的目录会 reject —— 「先 mkdir 再 writeFile」的顺序不是可选的`, async (t) => {
    const dir = await makeTempDir(t, 'storefs')
    const noSuchDir = path.join(dir, 'absent', 'cfg.json')

    await assert.rejects(
      () => fs.writeFile(noSuchDir, 'x'),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, 'ENOENT')
        return true
      }
    )

    // 正向对照:补上 mkdir 之后同一次写就成功了 —— 证明上一条抛的是「目录不存在」,不是别的毛病
    await fs.mkdir(path.dirname(noSuchDir))
    await fs.writeFile(noSuchDir, 'x')
    assert.equal(await fs.readFile(noSuchDir), 'x')
  })
}

test('L3-fs-6 三个适配器同形:方法名集合逐字相同(谁长歪了当场露出来)', () => {
  const shapes = ADAPTERS.map(([, fs]) => Object.keys(fs).sort())
  assert.deepEqual(shapes[0], ['mkdir', 'readFile', 'rename', 'writeFile'])
  assert.deepEqual(shapes[1], shapes[0], 'nodeChannelStoreFs 与 nodeBtTrackerStoreFs 应同形')
  assert.deepEqual(shapes[2], shapes[0], 'nodeProxyStoreFs 与 nodeBtTrackerStoreFs 应同形')
})
