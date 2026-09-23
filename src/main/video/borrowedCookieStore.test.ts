import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBorrowedCookieStore } from './borrowedCookieStore'
import type { OfferedCookie } from '../../shared/extensionProtocol'

/**
 * N2 —— 持有层「暂借登录态」(spec §8.1):
 * 整份覆盖不合并 / 精确 host 无父域回退(两向)/ `hosts()` 只出 host / `clear()` / `take` 部分命中。
 */

function ck(name: string, value: string, domain = 'www.example.com'): OfferedCookie {
  return { name, value, domain, path: '/', secure: false, httpOnly: false }
}

test('N2 offer 同域再借 = 整份覆盖,不合并(退登重登后旧 session cookie 不许阴魂不散)', () => {
  const store = createBorrowedCookieStore()
  store.offer('www.example.com', [ck('a', '1'), ck('b', '2')])
  store.offer('www.example.com', [ck('c', '3')])

  assert.deepEqual(store.take(['www.example.com']), [
    { host: 'www.example.com', cookies: [ck('c', '3')] }
  ])
  assert.equal(store.size(), 1)
})

test('N2 take 精确 host 命中', () => {
  const store = createBorrowedCookieStore()
  store.offer('www.bilibili.com', [ck('SESSDATA', 's1', '.bilibili.com')])

  assert.deepEqual(store.take(['www.bilibili.com']), [
    { host: 'www.bilibili.com', cookies: [ck('SESSDATA', 's1', '.bilibili.com')] }
  ])
})

test('N2 take 无父域回退(子 → 父):借了 a.github.io,点名 github.io 拿不到', () => {
  const store = createBorrowedCookieStore()
  store.offer('a.github.io', [ck('t', '1', 'a.github.io')])

  assert.deepEqual(store.take(['github.io']), [])
})

test('N2 take 无父域回退(父 → 子):借了 github.io,点名 a.github.io 拿不到', () => {
  const store = createBorrowedCookieStore()
  store.offer('github.io', [ck('t', '1', 'github.io')])

  // 没有 Public Suffix List 就分不清 a.github.io 与 b.github.io —— 缺就是缺
  assert.deepEqual(store.take(['a.github.io']), [])
})

test('N2 take 部分命中:只回命中的那些,缺的不占位、不报错', () => {
  const store = createBorrowedCookieStore()
  store.offer('one.example.com', [ck('x', '1')])

  assert.deepEqual(store.take(['one.example.com', 'two.example.com']), [
    { host: 'one.example.com', cookies: [ck('x', '1')] }
  ])
})

test('N2 hosts() 只出 host —— 返回值里不含任何 cookie 名 / 值', () => {
  const store = createBorrowedCookieStore()
  store.offer('one.example.com', [ck('secretName', 'secretValue')])
  store.offer('two.example.com', [ck('another', 'v2')])

  const hosts = store.hosts()
  assert.deepEqual(hosts, ['one.example.com', 'two.example.com'])
  // 形状断言:每一项都必须是纯字符串 host,不是对象、不含值
  for (const h of hosts) assert.equal(typeof h, 'string')
  const serialized = JSON.stringify(hosts)
  assert.equal(serialized.includes('secretValue'), false)
  assert.equal(serialized.includes('secretName'), false)
})

test('N2 clear() 清空全部,size() 归零,take 全落空', () => {
  const store = createBorrowedCookieStore()
  store.offer('one.example.com', [ck('x', '1')])
  store.offer('two.example.com', [ck('y', '2')])
  assert.equal(store.size(), 2)

  store.clear()

  assert.equal(store.size(), 0)
  assert.deepEqual(store.hosts(), [])
  assert.deepEqual(store.take(['one.example.com', 'two.example.com']), [])
})

test('N2 接口形状:没有任何能整份取出 cookie 值的方法(R3 靠形状保证,不靠纪律)', () => {
  const store = createBorrowedCookieStore()
  const record = store as unknown as Record<string, unknown>
  for (const forbidden of ['getAll', 'toJSON', 'entries', 'values', 'dump', 'all']) {
    assert.equal(record[forbidden], undefined, `不许存在 ${forbidden}()`)
  }
  // 正向对照:该有的五个方法都在(否则上面那串 undefined 断言可能只是因为对象是空的)
  for (const expected of ['offer', 'take', 'hosts', 'clear', 'size']) {
    assert.equal(typeof record[expected], 'function', `必须有 ${expected}()`)
  }
})

test('N2 offer 存副本:调用方此后改自己那份数组,持有层不受影响', () => {
  const store = createBorrowedCookieStore()
  const mine = [ck('a', '1')]
  store.offer('www.example.com', mine)
  mine.push(ck('b', '2'))

  assert.deepEqual(store.take(['www.example.com']), [
    { host: 'www.example.com', cookies: [ck('a', '1')] }
  ])
})

// —— v1.0 Task 3 Step 5 · #75:消费侧严格 www 别名 ——

test('#75 www.X <-> X 双向等价且返回实际 snapshot host', () => {
  for (const [offered, requested] of [
    ['www.youtube.com', 'youtube.com'],
    ['youtube.com', 'www.youtube.com']
  ]) {
    const store = createBorrowedCookieStore()
    const cookies = [ck('session', 'borrowed', '.youtube.com')]
    store.offer(offered, cookies)
    assert.deepEqual(store.take([requested]), [{ host: offered, cookies }])
    assert.deepEqual(store.hosts(), [offered], '取值不扩张持有域列表')
    assert.equal(store.size(), 1)
  }
})

test('#75 精确快照优先于别名,空快照也不回退', () => {
  const store = createBorrowedCookieStore()
  const alias = [ck('session', 'alias', '.example.com')]
  store.offer('www.example.com', alias)
  store.offer('example.com', [])
  assert.deepEqual(store.take(['example.com']), [{ host: 'example.com', cookies: [] }])
  assert.deepEqual(store.take(['www.example.com']), [{ host: 'www.example.com', cookies: alias }])
  const exact = [ck('session', 'exact', 'example.com')]
  store.offer('example.com', exact)
  assert.deepEqual(store.take(['example.com']), [{ host: 'example.com', cookies: exact }])
})

test('#75 同一快照通过 www / 裸域重复请求时只返回一次', () => {
  for (const offered of ['www.example.com', 'example.com']) {
    const store = createBorrowedCookieStore()
    const cookies = [ck('session', 'one', '.example.com')]
    store.offer(offered, cookies)
    assert.deepEqual(
      store.take(['example.com', 'www.example.com', 'example.com', 'www.example.com']),
      [{ host: offered, cookies }]
    )
  }
})

test('#75 take 最多两个实际快照,不把不同精确快照合并', () => {
  const store = createBorrowedCookieStore()
  const hosts = ['example.com', 'www.example.com', 'other.example.net', 'third.example.org']
  for (const [i, host] of hosts.entries()) store.offer(host, [ck('session', String(i), host)])
  assert.deepEqual(store.take(hosts), [
    { host: hosts[0], cookies: [ck('session', '0', hosts[0])] },
    { host: hosts[1], cookies: [ck('session', '1', hosts[1])] }
  ])
})

test('#75 ★ 越权对照:非 www 的子域仍不互通', () => {
  for (const [left, right] of [
    ['a.github.io', 'b.github.io'],
    ['a.github.io', 'github.io'],
    ['sub.example.com', 'example.com'],
    ['www.a.github.io', 'b.github.io'],
    ['www.example.com', 'sub.example.com']
  ]) {
    for (const [offered, requested] of [
      [left, right],
      [right, left]
    ]) {
      const store = createBorrowedCookieStore()
      const cookies = [ck('session', 'private', offered)]
      store.offer(offered, cookies)
      assert.deepEqual(store.take([requested]), [], offered + ' -> ' + requested)
      assert.deepEqual(store.take([offered]), [{ host: offered, cookies }], '精确匹配正向对照')
    }
  }
})

test('#75 端口隔离:非默认端口只在同端口 www 别名间等价', () => {
  const store = createBorrowedCookieStore()
  const a = [ck('session', 'port8443', '.example.com')]
  const b = [ck('session', 'port9443', '.example.com')]
  store.offer('www.example.com:8443', a)
  store.offer('example.com:9443', b)
  assert.deepEqual(store.take(['example.com:8443']), [{ host: 'www.example.com:8443', cookies: a }])
  assert.deepEqual(store.take(['www.example.com:9443']), [{ host: 'example.com:9443', cookies: b }])
  for (const requested of ['example.com', 'www.example.com', 'example.com:7443']) {
    assert.deepEqual(store.take([requested]), [], requested)
  }
})

test('#75 别名取值保留原 cookie.domain/value,数组副本不反写持有层', () => {
  const store = createBorrowedCookieStore()
  const cookies = [
    ck('hostOnly', 'host-secret', 'www.example.com'),
    ck('shared', 'domain-secret', '.example.com')
  ]
  store.offer('www.example.com', cookies)
  const taken = store.take(['example.com'])
  assert.deepEqual(taken, [{ host: 'www.example.com', cookies }])
  taken[0].cookies.push(ck('extra', 'not-stored'))
  assert.deepEqual(store.take(['example.com']), [{ host: 'www.example.com', cookies }])
})
