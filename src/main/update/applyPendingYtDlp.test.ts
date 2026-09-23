import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyPendingYtDlp, type ApplyPendingFs } from './applyPendingYtDlp'
import { MIN_VALID_YTDLP_BYTES } from '../binaries/ensureWritable'
import { pendingYtDlpPath } from './paths'

const YTDLP = 'C:/userData/bin/yt-dlp.exe'
const PENDING = pendingYtDlpPath(YTDLP)

/** 内存 fake fs:sizes 记录各路径大小;renames / unlinks 记录动作 */
function createFakeFs(sizes: Record<string, number>): ApplyPendingFs & {
  renames: Array<[string, string]>
  unlinks: string[]
  sizes: Record<string, number>
} {
  return {
    sizes: { ...sizes },
    renames: [],
    unlinks: [],
    existsSync(path) {
      return path in this.sizes
    },
    statSync(path) {
      if (!(path in this.sizes)) throw new Error(`ENOENT ${path}`)
      return { size: this.sizes[path] }
    },
    renameSync(oldPath, newPath) {
      this.renames.push([oldPath, newPath])
      this.sizes[newPath] = this.sizes[oldPath]
      delete this.sizes[oldPath]
    },
    unlinkSync(path) {
      this.unlinks.push(path)
      delete this.sizes[path]
    }
  }
}

test('pending 有效(≥阈值)→ rename 覆盖 yt-dlp.exe(applied)', () => {
  const fs = createFakeFs({ [PENDING]: MIN_VALID_YTDLP_BYTES })
  const r = applyPendingYtDlp({ ytdlpPath: YTDLP, fs })
  assert.equal(r.action, 'applied')
  assert.deepEqual(fs.renames, [[PENDING, YTDLP]], 'pending → yt-dlp.exe 覆盖')
  assert.equal(fs.unlinks.length, 0)
})

test('pending 无效(<阈值,占位 / 损坏)→ 仅删除(discarded),不污染副本', () => {
  const fs = createFakeFs({ [PENDING]: 12 })
  const r = applyPendingYtDlp({ ytdlpPath: YTDLP, fs })
  assert.equal(r.action, 'discarded')
  assert.deepEqual(fs.unlinks, [PENDING], '仅删除 pending')
  assert.equal(fs.renames.length, 0, '绝不 rename 无效文件覆盖 yt-dlp.exe')
})

test('无 pending → no-op(none)', () => {
  const fs = createFakeFs({})
  const r = applyPendingYtDlp({ ytdlpPath: YTDLP, fs })
  assert.equal(r.action, 'none')
  assert.equal(fs.renames.length, 0)
  assert.equal(fs.unlinks.length, 0)
})

test('异常吞为 error(不拖垮启动)', () => {
  const fs = createFakeFs({ [PENDING]: MIN_VALID_YTDLP_BYTES })
  fs.renameSync = () => {
    throw new Error('EPERM')
  }
  const r = applyPendingYtDlp({ ytdlpPath: YTDLP, fs })
  assert.equal(r.action, 'error', '异常吞掉,pending 保留待下次重试')
})
