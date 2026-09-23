import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { createYtdlpProcess } from './ytdlpProcess'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  pid?: number
  kill(signal?: string): boolean
}

/** 假子进程:stdout/stderr 为可写流,kill 触发 close(null)模拟被信号杀死;可选 pid(审计#1 树杀断言) */
function makeFakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.pid = pid
  child.kill = (signal?: string) => {
    child.killed = true
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', null, signal ?? 'SIGTERM')
    })
    return true
  }
  return child
}

test('createYtdlpProcess.run collects stdout / stderr / exitCode (spawn injected)', async () => {
  const child = makeFakeChild()
  const spawn = (() => {
    queueMicrotask(() => {
      child.stdout.write('{"id":"x"}')
      child.stderr.write('a warning')
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0, null)
    })
    return child
  }) as unknown as typeof import('child_process').spawn

  const proc = createYtdlpProcess({ spawn })
  const result = await proc.run('yt-dlp', ['-J', 'https://x'])
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, '{"id":"x"}')
  assert.equal(result.stderr, 'a warning')
})

test('createYtdlpProcess.run streams stdout line-by-line via onLine (--newline, strips \\r)', async () => {
  const child = makeFakeChild()
  const spawn = (() => {
    queueMicrotask(() => {
      child.stdout.write('dlp:downloading|1|2|0|3\r\n[Merger] x\n')
      child.stdout.write('D:\\out.mp4\n')
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0, null)
    })
    return child
  }) as unknown as typeof import('child_process').spawn

  const lines: string[] = []
  const proc = createYtdlpProcess({ spawn })
  await proc.run('yt-dlp', ['-o', 'x'], { onLine: (l) => lines.push(l) })
  assert.deepEqual(lines, ['dlp:downloading|1|2|0|3', '[Merger] x', 'D:\\out.mp4'])
})

test('createYtdlpProcess.run kills the child on AbortSignal and resolves with null exitCode', async () => {
  const child = makeFakeChild()
  const spawn = (() => child) as unknown as typeof import('child_process').spawn

  const ac = new AbortController()
  const proc = createYtdlpProcess({ spawn })
  const p = proc.run('yt-dlp', ['-J', 'https://x'], { signal: ac.signal })
  ac.abort()
  const result = await p
  assert.equal(child.killed, true)
  assert.equal(result.exitCode, null)
})

test('createYtdlpProcess.run rejects when spawn errors (ENOENT)', async () => {
  const child = makeFakeChild()
  const spawn = (() => {
    queueMicrotask(() => child.emit('error', new Error('spawn yt-dlp ENOENT')))
    return child
  }) as unknown as typeof import('child_process').spawn
  const proc = createYtdlpProcess({ spawn })
  await assert.rejects(proc.run('yt-dlp', ['-J']), /ENOENT/)
})

test('createYtdlpProcess.run abort → 注入 treeKill(taskkill /T /F)先于 child.kill,防 PyInstaller orphan(审计#1)', async () => {
  const child = makeFakeChild(4321)
  const spawn = (() => child) as unknown as typeof import('child_process').spawn
  const treeKilled: number[] = []
  const order: string[] = []
  const origKill = child.kill.bind(child)
  child.kill = (signal?: string) => {
    order.push('kill')
    return origKill(signal)
  }

  const ac = new AbortController()
  const proc = createYtdlpProcess({
    spawn,
    treeKill: (pid) => {
      order.push('tree')
      treeKilled.push(pid)
    }
  })
  const p = proc.run('yt-dlp', ['-J', 'https://x'], { signal: ac.signal })
  ac.abort()
  const result = await p

  assert.deepEqual(treeKilled, [4321], 'abort → 注入 treeKill 以 pid 调用(taskkill /T /F 整棵树)')
  assert.deepEqual(
    order,
    ['tree', 'kill'],
    '先树杀(含 PyInstaller Python 子进程)再 child.kill 兜底'
  )
  assert.equal(child.killed, true, 'child.kill 兜底被调')
  assert.equal(result.exitCode, null, '被 kill → exitCode null(调用方据此映射「超时 / 取消」)')
})

test('createYtdlpProcess.run 无注入 treeKill + 无 pid → 仅 child.kill 兜底(现有 abort 路径零回归)', async () => {
  const child = makeFakeChild() // 无 pid
  const spawn = (() => child) as unknown as typeof import('child_process').spawn
  const ac = new AbortController()
  const proc = createYtdlpProcess({ spawn }) // 未注入 treeKill
  const p = proc.run('yt-dlp', ['-J', 'https://x'], { signal: ac.signal })
  ac.abort()
  const result = await p
  assert.equal(child.killed, true, '无 pid → killChildTree 走 child.kill 兜底')
  assert.equal(result.exitCode, null)
})
