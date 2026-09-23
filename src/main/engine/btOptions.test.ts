import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyFileSelection,
  buildBtOptions,
  magnetDisplayName,
  selectFileArg,
  toBase64,
  toSeedOptions
} from './btOptions'
import type { TorrentFile } from '../../shared/ipc'

// ==================== buildBtOptions(BT 任务级选项,spec §4.2)====================

test('buildBtOptions: 含 dir / follow-torrent=true / seed-time=0 / bt-save-metadata=true', () => {
  assert.deepEqual(buildBtOptions({ dir: 'D:/Downloads/Torrents' }), {
    dir: 'D:/Downloads/Torrents',
    'follow-torrent': 'true',
    'seed-time': '0',
    'bt-save-metadata': 'true'
  })
})

test('buildBtOptions: dir 原样透传(不改写)', () => {
  assert.equal(buildBtOptions({ dir: '/home/u/Torrents' }).dir, '/home/u/Torrents')
})

test('buildBtOptions: 不含 select-file / bt-metadata-only(Task 1 整包,非只取元数据)', () => {
  const opts = buildBtOptions({ dir: 'x' })
  assert.equal('select-file' in opts, false)
  assert.equal('bt-metadata-only' in opts, false)
})

// ==================== buildBtOptions(Task 2 三新参:按需叠加 + 缺省零回归,spec §3.3)====================

test('buildBtOptions: 缺省(仅 dir)= Task 1 四项逐字节等价,零回归(不叠加任何新键)', () => {
  // selectFile/pauseMetadata/pause 未传 → 结果与 Task 1 完全一致(deepEqual 精确锚定,防新参污染缺省)
  assert.deepEqual(buildBtOptions({ dir: 'x' }), {
    dir: 'x',
    'follow-torrent': 'true',
    'seed-time': '0',
    'bt-save-metadata': 'true'
  })
})

test('buildBtOptions: selectFile 有值 → 叠加 select-file + bt-remove-unselected-file(其余 Task 1 四项恒在)', () => {
  const opts = buildBtOptions({ dir: 'x', selectFile: '1,3-5' })
  assert.equal(opts['select-file'], '1,3-5')
  // 2026-07-25 真机修订三:部分选择时完成后由 aria2 删未选文件(0B 占位 + 同 piece 边界字节)
  assert.equal(opts['bt-remove-unselected-file'], 'true')
  assert.equal(opts.dir, 'x')
  assert.equal(opts['follow-torrent'], 'true')
  assert.equal(opts['seed-time'], '0')
  assert.equal(opts['bt-save-metadata'], 'true')
})

test('buildBtOptions: selectFile=null / 空串(全选)→ 不叠加 select-file(整包零回归)', () => {
  assert.equal('select-file' in buildBtOptions({ dir: 'x', selectFile: null }), false)
  assert.equal('select-file' in buildBtOptions({ dir: 'x', selectFile: '' }), false)
  // 全选无未选文件,同样不叠加 remove-unselected(零回归)
  assert.equal('bt-remove-unselected-file' in buildBtOptions({ dir: 'x', selectFile: null }), false)
  assert.equal('bt-remove-unselected-file' in buildBtOptions({ dir: 'x', selectFile: '' }), false)
})

test('buildBtOptions: pauseMetadata → pause-metadata=true(磁力待选);pause → pause=true(.torrent 待选)', () => {
  assert.equal(buildBtOptions({ dir: 'x', pauseMetadata: true })['pause-metadata'], 'true')
  assert.equal('pause' in buildBtOptions({ dir: 'x', pauseMetadata: true }), false)
  assert.equal(buildBtOptions({ dir: 'x', pause: true }).pause, 'true')
  assert.equal('pause-metadata' in buildBtOptions({ dir: 'x', pause: true }), false)
})

test('buildBtOptions: pauseMetadata=false / pause=false → 不叠加(缺省零回归)', () => {
  const opts = buildBtOptions({ dir: 'x', pauseMetadata: false, pause: false, selectFile: null })
  assert.equal('pause-metadata' in opts, false)
  assert.equal('pause' in opts, false)
  assert.equal('select-file' in opts, false)
})

// ==================== toSeedOptions(做种档 → aria2 选项,v0.3 Task 3 · spec §2.2)====================

test('toSeedOptions: 未传 / 关档 → { seed-time: "0" }(下载完即停,零回归)', () => {
  assert.deepEqual(toSeedOptions(), { 'seed-time': '0' })
  assert.deepEqual(toSeedOptions({ enabled: false, ratio: 1, timeMin: 60 }), { 'seed-time': '0' })
})

test('toSeedOptions: 开档 → seed-ratio + seed-time(timeMin>0)', () => {
  assert.deepEqual(toSeedOptions({ enabled: true, ratio: 1.5, timeMin: 60 }), {
    'seed-ratio': '1.5',
    'seed-time': '60'
  })
})

test('toSeedOptions: timeMin=0 → 省略 seed-time(不按时间停,只按分享率)', () => {
  const opts = toSeedOptions({ enabled: true, ratio: 2, timeMin: 0 })
  assert.equal(opts['seed-ratio'], '2')
  assert.equal('seed-time' in opts, false, 'timeMin=0 省略 seed-time')
})

test('toSeedOptions: ratio=0 → seed-ratio="0"(不按分享率停,合法无限做种)', () => {
  assert.deepEqual(toSeedOptions({ enabled: true, ratio: 0, timeMin: 0 }), { 'seed-ratio': '0' })
})

test('toSeedOptions: maxPeers>0 → 加 bt-max-peers;=0 / 省略 → 不加(跟随全局)', () => {
  assert.equal(
    toSeedOptions({ enabled: true, ratio: 1, timeMin: 60, maxPeers: 200 })['bt-max-peers'],
    '200'
  )
  assert.equal(
    'bt-max-peers' in toSeedOptions({ enabled: true, ratio: 1, timeMin: 60, maxPeers: 0 }),
    false
  )
  assert.equal('bt-max-peers' in toSeedOptions({ enabled: true, ratio: 1, timeMin: 60 }), false)
})

// ==================== buildBtOptions × seed(做种档注入,v0.3 Task 3)====================

test('buildBtOptions: 不带 seed 缺省仍 seed-time="0"(零回归,现有断言不破)', () => {
  const opts = buildBtOptions({ dir: 'x' })
  assert.equal(opts['seed-time'], '0')
  assert.equal('seed-ratio' in opts, false, '缺省无 seed-ratio')
})

test('buildBtOptions: 带 seed 开档 → seed-ratio/seed-time 叠加(替换 seed-time="0"),Task 1 其余项恒在', () => {
  const opts = buildBtOptions({ dir: 'x', seed: { enabled: true, ratio: 1, timeMin: 120 } })
  assert.equal(opts['seed-ratio'], '1')
  assert.equal(opts['seed-time'], '120', '开档 seed-time 为配置值(非 0)')
  assert.equal(opts.dir, 'x')
  assert.equal(opts['follow-torrent'], 'true')
  assert.equal(opts['bt-save-metadata'], 'true')
})

test('buildBtOptions: 带 seed 关档 → seed-time="0"、无 seed-ratio(等价缺省)', () => {
  const opts = buildBtOptions({ dir: 'x', seed: { enabled: false, ratio: 1, timeMin: 60 } })
  assert.equal(opts['seed-time'], '0')
  assert.equal('seed-ratio' in opts, false)
})

test('buildBtOptions: seed 与 selectFile 共存 → 两组选项并存(叠加正交)', () => {
  const opts = buildBtOptions({
    dir: 'x',
    selectFile: '1,3',
    seed: { enabled: true, ratio: 2, timeMin: 30, maxPeers: 100 }
  })
  assert.equal(opts['select-file'], '1,3')
  assert.equal(opts['bt-remove-unselected-file'], 'true')
  assert.equal(opts['seed-ratio'], '2')
  assert.equal(opts['seed-time'], '30')
  assert.equal(opts['bt-max-peers'], '100')
})

// ==================== selectFileArg(勾选布尔 → --select-file 索引串,spec §3.3)====================

function filesOf(...selected: boolean[]): Pick<TorrentFile, 'selected'>[] {
  return selected.map((s) => ({ selected: s }))
}

test('selectFileArg: 全选 → null(= 整包,不传 select-file,零回归)', () => {
  assert.equal(selectFileArg(filesOf(true, true, true)), null)
})

test('selectFileArg: 空数组 → null(vacuous 全选,边界)', () => {
  assert.equal(selectFileArg([]), null)
})

test('selectFileArg: 部分选 → 1-based 升序压缩区间 "1,3-5,7"', () => {
  // 选中 0-based [0,2,3,4,6] → 1-based [1,3,4,5,7] → 连续段压缩
  assert.equal(selectFileArg(filesOf(true, false, true, true, true, false, true)), '1,3-5,7')
})

test('selectFileArg: 单选 → "2"(1-based)', () => {
  assert.equal(selectFileArg(filesOf(false, true, false)), '2')
})

test('selectFileArg: 相邻两段与散点混合 → 正确压缩', () => {
  // 1-based 选中 [1,2,3,5,6,9] → "1-3,5-6,9"
  assert.equal(
    selectFileArg(filesOf(true, true, true, false, true, true, false, false, true)),
    '1-3,5-6,9'
  )
})

// ==================== applyFileSelection(索引集 → 定型 files[].selected,spec §3.3)====================

function torrentFiles(...selected: boolean[]): TorrentFile[] {
  return selected.map((s, i) => ({
    path: `dir/file${i + 1}.bin`,
    length: (i + 1) * 100,
    selected: s
  }))
}

test('applyFileSelection: 按 1-based 索引集置位(选中 true / 未选 false)', () => {
  const files = torrentFiles(true, true, true, true)
  const out = applyFileSelection(files, [1, 3])
  assert.deepEqual(
    out.map((f) => f.selected),
    [true, false, true, false],
    '索引 1/3(1-based)选中,2/4 取消'
  )
})

test('applyFileSelection: 越界索引忽略(不匹配任何 files[i])', () => {
  const files = torrentFiles(false, false)
  const out = applyFileSelection(files, [1, 99, 0, -1])
  assert.deepEqual(
    out.map((f) => f.selected),
    [true, false],
    '仅 1 命中;99/0/-1 越界忽略(不越位、不抛)'
  )
})

test('applyFileSelection: 保序 + 不可变(返回新数组 / 新对象,原数组不改)', () => {
  const files = torrentFiles(true, false, true)
  const out = applyFileSelection(files, [2])
  // 保序:path/length 逐位不变
  assert.deepEqual(
    out.map((f) => f.path),
    ['dir/file1.bin', 'dir/file2.bin', 'dir/file3.bin']
  )
  assert.deepEqual(
    out.map((f) => f.length),
    [100, 200, 300]
  )
  // 不可变:原数组元素引用与选中态未被改写
  assert.notEqual(out, files, '返回新数组')
  assert.notEqual(out[0], files[0], '逐项新对象(浅拷贝)')
  assert.deepEqual(
    files.map((f) => f.selected),
    [true, false, true],
    '原 files[].selected 未被污染'
  )
})

test('applyFileSelection: 与 selectFileArg 往返一致(选 [1,3,4,5,7] → "1,3-5,7")', () => {
  const files = torrentFiles(false, false, false, false, false, false, false)
  const out = applyFileSelection(files, [1, 3, 4, 5, 7])
  assert.equal(selectFileArg(out), '1,3-5,7', 'applyFileSelection ∘ selectFileArg 闭环')
})

// ==================== magnetDisplayName(dn 占位名提取)====================

test('magnetDisplayName: 提取 dn 参数(percent / + 均解码)', () => {
  assert.equal(
    magnetDisplayName('magnet:?xt=urn:btih:abcdef123&dn=Big+Buck+Bunny&tr=udp://t'),
    'Big Buck Bunny'
  )
  assert.equal(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=Movie%20Title.mkv'), 'Movie Title.mkv')
})

test('magnetDisplayName: 无 dn / 无 query / 全空白 → null', () => {
  assert.equal(magnetDisplayName('magnet:?xt=urn:btih:abcdef123'), null)
  assert.equal(magnetDisplayName('magnet:'), null)
  assert.equal(magnetDisplayName('magnet:?xt=urn:btih:abc&dn='), null)
  assert.equal(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=%20%20'), null)
})

// ==================== toBase64(种子字节 → base64,供 addTorrent)====================

test('toBase64: 编码与往返一致', () => {
  assert.equal(toBase64(Buffer.from('hello')), 'aGVsbG8=')
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
  assert.ok(Buffer.from(toBase64(bytes), 'base64').equals(bytes))
})
