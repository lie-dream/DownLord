/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRef, type ComponentProps } from 'react'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import Toolbar from './Toolbar'

afterEach(cleanup)

const searchName = '搜索当前列表任务'
const scopeDescription = '仅搜索已加载任务；全部开始 / 全部暂停不受筛选影响。'
const startDescription = '继续所有已加载的已暂停任务，不受导航、类别和搜索筛选影响。'
const pauseDescription = '暂停所有已加载的下载中任务，不受导航、类别和搜索筛选影响。'

function makeProps(searchQuery = ''): ComponentProps<typeof Toolbar> {
  return {
    title: '全部任务',
    searchQuery,
    onSearchQueryChange: () => {},
    onClearSearch: () => {},
    searchInputRef: createRef<HTMLInputElement>(),
    onStartAll: () => {},
    onPauseAll: () => {}
  }
}

test('T7-A13 exposes the named text searchbox, exact attributes and caller-owned ref without autofocus', () => {
  const props = makeProps('  Report  ')
  const { container, unmount } = render(<Toolbar {...props} />)
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement

  assert.ok(screen.getByRole('heading', { name: '全部任务' }))
  assert.equal(input.type, 'text')
  assert.equal(input.getAttribute('role'), 'searchbox')
  assert.equal(input.getAttribute('aria-label'), searchName)
  assert.equal(input.placeholder, '搜索文件名或来源')
  assert.equal(input.autocomplete, 'off')
  assert.equal(input.getAttribute('spellcheck'), 'false')
  assert.equal(input.disabled, false)
  assert.equal(input.readOnly, false)
  assert.equal(input.value, '  Report  ')
  assert.equal(props.searchInputRef.current, input)
  assert.notEqual(document.activeElement, input)
  assert.equal(container.querySelector('[autofocus]'), null)
  assert.equal(container.querySelector('form'), null)
  assert.equal(container.querySelector('[aria-live]'), null)

  unmount()
  assert.equal(props.searchInputRef.current, null)
})

test('T7-A02 forwards every raw change immediately and remains controlled across rerenders', () => {
  const changes: string[] = []
  const props = makeProps()
  props.onSearchQueryChange = (query) => changes.push(query)
  const { rerender } = render(<Toolbar {...props} />)
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
  const queries = ['  Report  ', 'a b', 'ab', '   ', '']

  for (const [index, query] of queries.entries()) {
    fireEvent.change(input, { target: { value: query } })
    assert.deepEqual(changes, queries.slice(0, index + 1))
    assert.equal(input.value, props.searchQuery, 'Toolbar must not own a second query')

    props.searchQuery = query
    rerender(<Toolbar {...props} />)
    assert.equal(screen.getByRole('searchbox', { name: searchName }), input)
    assert.equal(input.value, query)
  }
})

test('T7-A02 T7-A13 forwards composition changes verbatim without a second committed query', () => {
  const changes: string[] = []
  const actions: string[] = []
  const props = makeProps()
  props.onSearchQueryChange = (query) => changes.push(query)
  props.onClearSearch = () => actions.push('clear')
  props.onStartAll = () => actions.push('start')
  props.onPauseAll = () => actions.push('pause')
  const { rerender } = render(<Toolbar {...props} />)
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
  input.focus()
  fireEvent.compositionStart(input)
  const queries = ['z', '中', '  中文报告  ']

  for (const [index, query] of queries.entries()) {
    fireEvent.change(input, { target: { value: query } })
    assert.deepEqual(changes, queries.slice(0, index + 1))
    props.searchQuery = query
    rerender(<Toolbar {...props} />)
    assert.equal(screen.getByRole('searchbox', { name: searchName }), input)
    assert.equal(input.value, query)
    assert.equal(document.activeElement, input)
  }

  fireEvent.compositionEnd(input, { data: '中文报告' })
  assert.deepEqual(changes, queries)
  assert.deepEqual(actions, [])
  assert.equal(input.value, '  中文报告  ')
})

test('T7-A09 T7-A13 shows clear for raw nonempty queries and delegates query and focus ownership', () => {
  const actions: string[] = []
  const props = makeProps()
  props.onSearchQueryChange = () => actions.push('change')
  props.onClearSearch = () => actions.push('clear')
  props.onStartAll = () => actions.push('start')
  props.onPauseAll = () => actions.push('pause')
  const { rerender } = render(<Toolbar {...props} />)
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
  assert.equal(screen.queryByRole('button', { name: '清除搜索' }), null)

  for (const [index, query] of ['Report', '   '].entries()) {
    props.searchQuery = query
    rerender(<Toolbar {...props} />)
    const clear = screen.getByRole('button', { name: '清除搜索' }) as HTMLButtonElement
    assert.equal(clear.type, 'button')
    assert.equal(clear.title, '清除搜索（Esc）')
    assert.ok(clear.querySelector('[aria-hidden="true"]'))
    clear.focus()
    fireEvent.click(clear)

    // 此回调刻意不模拟 App；Toolbar 只通知，不接管查询或清除后的聚焦。
    assert.deepEqual(actions, Array(index + 1).fill('clear'))
    assert.equal(input.value, query)
    assert.equal(document.activeElement, clear)
  }

  props.searchQuery = ''
  rerender(<Toolbar {...props} />)
  assert.equal(input.value, '')
  assert.equal(screen.queryByRole('button', { name: '清除搜索' }), null)
})

for (const [label, query] of [
  ['text', 'Report'],
  ['whitespace', '   ']
]) {
  test(`T7-A09 T7-A13 consumes focused nonempty Escape (${label}) and leaves empty Escape unhandled after rerender`, () => {
    const actions: string[] = []
    const bubbled: string[] = []
    const props = makeProps(query)
    props.onClearSearch = () => actions.push('clear')
    props.onSearchQueryChange = () => actions.push('change')
    props.onStartAll = () => actions.push('start')
    props.onPauseAll = () => actions.push('pause')
    const onKeyDown = (event: React.KeyboardEvent): void => {
      bubbled.push(event.key)
    }
    const { rerender } = render(
      <div onKeyDown={onKeyDown}>
        <Toolbar {...props} />
      </div>
    )
    const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
    input.focus()
    const escape = createEvent.keyDown(input, {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: false
    })

    assert.equal(fireEvent(input, escape), false)
    assert.equal(escape.defaultPrevented, true)
    assert.deepEqual(bubbled, [])
    assert.deepEqual(actions, ['clear'])
    assert.equal(input.value, query)

    props.searchQuery = ''
    rerender(
      <div onKeyDown={onKeyDown}>
        <Toolbar {...props} />
      </div>
    )
    assert.equal(screen.getByRole('searchbox', { name: searchName }), input)
    assert.equal(document.activeElement, input)
    assert.equal(input.value, '')
    assert.equal(screen.queryByRole('button', { name: '清除搜索' }), null)
    const emptyEscape = createEvent.keyDown(input, {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
    assert.equal(fireEvent(input, emptyEscape), true)
    assert.equal(emptyEscape.defaultPrevented, false)
    assert.deepEqual(bubbled, ['Escape'])
    assert.deepEqual(actions, ['clear'])
  })
}

test('T7-A13 preserves the composition-ref Escape guard across controlled rerenders until composition end', () => {
  const changes: string[] = []
  const bubbled: string[] = []
  let clears = 0
  const props = makeProps('zh')
  props.onSearchQueryChange = (query) => changes.push(query)
  props.onClearSearch = () => clears++
  const onKeyDown = (event: React.KeyboardEvent): void => {
    bubbled.push(event.key)
  }
  const { rerender } = render(
    <div onKeyDown={onKeyDown}>
      <Toolbar {...props} />
    </div>
  )
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
  input.focus()
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: '中' } })
  assert.deepEqual(changes, ['中'])
  props.searchQuery = '中'
  rerender(
    <div onKeyDown={onKeyDown}>
      <Toolbar {...props} />
    </div>
  )
  assert.equal(screen.getByRole('searchbox', { name: searchName }), input)

  for (const key of ['Escape', 'Enter']) {
    const event = createEvent.keyDown(input, {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: false
    })
    assert.equal(fireEvent(input, event), true)
    assert.equal(event.defaultPrevented, false)
  }
  assert.deepEqual(bubbled, ['Escape', 'Enter'])
  assert.equal(clears, 0)
  assert.equal(input.value, '中')

  fireEvent.compositionEnd(input, { data: '中' })
  const escape = createEvent.keyDown(input, {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    isComposing: false
  })
  assert.equal(fireEvent(input, escape), false)
  assert.equal(escape.defaultPrevented, true)
  assert.deepEqual(bubbled, ['Escape', 'Enter'])
  assert.equal(clears, 1)
  assert.deepEqual(changes, ['中'])
})

test('T7-A13 honors native isComposing Escape independently of composition-start events', () => {
  const bubbled: string[] = []
  let clears = 0
  const props = makeProps('中文')
  props.onClearSearch = () => clears++
  render(
    <div onKeyDown={(event) => bubbled.push(event.key)}>
      <Toolbar {...props} />
    </div>
  )
  const input = screen.getByRole('searchbox', { name: searchName })
  input.focus()
  const composingEscape = createEvent.keyDown(input, {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    isComposing: true
  })

  assert.equal((composingEscape as KeyboardEvent).isComposing, true)
  assert.equal(fireEvent(input, composingEscape), true)
  assert.equal(composingEscape.defaultPrevented, false)
  assert.deepEqual(bubbled, ['Escape'])
  assert.equal(clears, 0)

  const escape = createEvent.keyDown(input, {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    isComposing: false
  })
  assert.equal(fireEvent(input, escape), false)
  assert.equal(escape.defaultPrevented, true)
  assert.deepEqual(bubbled, ['Escape'])
  assert.equal(clears, 1)
})

test('T7-A13 leaves Enter uncancelled and bubbling without any query or task action', () => {
  const actions: string[] = []
  const bubbled: string[] = []
  const props = makeProps()
  props.onSearchQueryChange = () => actions.push('change')
  props.onClearSearch = () => actions.push('clear')
  props.onStartAll = () => actions.push('start')
  props.onPauseAll = () => actions.push('pause')
  const onKeyDown = (event: React.KeyboardEvent): void => {
    bubbled.push(event.key)
  }
  const { rerender } = render(
    <div onKeyDown={onKeyDown}>
      <Toolbar {...props} />
    </div>
  )
  const input = screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement
  input.focus()

  for (const query of ['', 'Report', '   ']) {
    props.searchQuery = query
    rerender(
      <div onKeyDown={onKeyDown}>
        <Toolbar {...props} />
      </div>
    )
    const enter = createEvent.keyDown(input, { key: 'Enter', bubbles: true, cancelable: true })
    assert.equal(fireEvent(input, enter), true)
    assert.equal(enter.defaultPrevented, false)
    assert.equal(input.value, query)
  }

  assert.deepEqual(bubbled, ['Enter', 'Enter', 'Enter'])
  assert.deepEqual(actions, [])
})

test('T7-A13 ignores Escape outside the focused input and does not steal focus on prop rerenders', () => {
  const bubbled: string[] = []
  let clears = 0
  const props = makeProps('Report')
  props.onClearSearch = () => clears++
  const onKeyDown = (event: React.KeyboardEvent): void => {
    bubbled.push(event.key)
  }
  const { rerender } = render(
    <div onKeyDown={onKeyDown}>
      <button type="button">别处</button>
      <Toolbar {...props} />
    </div>
  )
  const input = screen.getByRole('searchbox', { name: searchName })
  const outside = screen.getByRole('button', { name: '别处' })
  const controls = [
    outside,
    screen.getByRole('button', { name: '清除搜索' }),
    screen.getByRole('button', { name: '全部开始' }),
    screen.getByRole('button', { name: '全部暂停' })
  ]
  for (const control of controls) {
    control.focus()
    const escape = createEvent.keyDown(control, { key: 'Escape', bubbles: true, cancelable: true })
    assert.equal(fireEvent(control, escape), true)
    assert.equal(escape.defaultPrevented, false)
  }

  outside.focus()
  const unfocusedEscape = createEvent.keyDown(input, {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  })
  assert.equal(fireEvent(input, unfocusedEscape), true)
  assert.equal(unfocusedEscape.defaultPrevented, false)
  props.title = '下载中'
  props.searchQuery = 'Next'
  rerender(
    <div onKeyDown={onKeyDown}>
      <button type="button">别处</button>
      <Toolbar {...props} />
    </div>
  )
  assert.equal(screen.getByRole('searchbox', { name: searchName }), input)
  assert.ok(screen.getByRole('heading', { name: '下载中' }))
  assert.equal(document.activeElement, outside)
  assert.deepEqual(bubbled, Array(5).fill('Escape'))
  assert.equal(clears, 0)
})

test('T7-A13 keeps the unchanged bulk buttons enabled and their callbacks independent of search', () => {
  const actions: string[] = []
  const props = makeProps()
  props.onSearchQueryChange = () => actions.push('change')
  props.onClearSearch = () => actions.push('clear')
  props.onStartAll = () => actions.push('start')
  props.onPauseAll = () => actions.push('pause')
  const { rerender } = render(<Toolbar {...props} />)

  for (const query of ['', 'no-matching-task', '   ']) {
    props.searchQuery = query
    rerender(<Toolbar {...props} />)
    const start = screen.getByRole('button', { name: '全部开始' }) as HTMLButtonElement
    const pause = screen.getByRole('button', { name: '全部暂停' }) as HTMLButtonElement
    assert.equal(start.type, 'button')
    assert.equal(pause.type, 'button')
    assert.equal(start.disabled, false)
    assert.equal(pause.disabled, false)
    actions.length = 0
    fireEvent.click(start)
    assert.deepEqual(actions, ['start'])
    fireEvent.click(pause)
    assert.deepEqual(actions, ['start', 'pause'])
    assert.equal(
      (screen.getByRole('searchbox', { name: searchName }) as HTMLInputElement).value,
      query
    )
  }
})

test('T7-A13 associates the visible scope note and distinct bulk descriptions without live regions', () => {
  const { container } = render(<Toolbar {...makeProps('Report')} />)
  const input = screen.getByRole('searchbox', { name: searchName, description: scopeDescription })
  const start = screen.getByRole('button', { name: '全部开始', description: startDescription })
  const pause = screen.getByRole('button', { name: '全部暂停', description: pauseDescription })
  const note = screen.getByText(scopeDescription, { exact: true })
  const startText = screen.getByText(startDescription, { exact: true })
  const pauseText = screen.getByText(pauseDescription, { exact: true })

  assert.equal(start.title, startDescription)
  assert.equal(pause.title, pauseDescription)
  assert.equal(input.getAttribute('aria-describedby'), note.id)
  assert.equal(start.getAttribute('aria-describedby'), startText.id)
  assert.equal(pause.getAttribute('aria-describedby'), pauseText.id)
  const ids = [note.id, startText.id, pauseText.id]
  assert.ok(ids.every(Boolean))
  assert.equal(new Set(ids).size, 3)
  assert.equal(
    note.parentElement,
    container.firstElementChild,
    'scope note is separate from controls'
  )
  assert.equal(note.closest('[hidden], [aria-hidden="true"]'), null)
  assert.equal(container.querySelector('[aria-live]'), null)
  for (const icon of container.querySelectorAll('svg')) {
    assert.equal(icon.getAttribute('aria-hidden'), 'true')
  }
})

test('T7-A13 preserves natural control DOM order as the clear button appears and disappears', () => {
  const props = makeProps()
  const { container, rerender } = render(<Toolbar {...props} />)
  const input = screen.getByRole('searchbox', { name: searchName })
  const start = screen.getByRole('button', { name: '全部开始' })
  const pause = screen.getByRole('button', { name: '全部暂停' })

  for (const query of ['', 'Report', '   ', '']) {
    props.searchQuery = query
    rerender(<Toolbar {...props} />)
    const expected = [input]
    if (query.length > 0) expected.push(screen.getByRole('button', { name: '清除搜索' }))
    expected.push(start, pause)
    const controls = Array.from(container.querySelectorAll<HTMLElement>('input, button'))
    assert.deepEqual(controls, expected)
    for (const control of controls) {
      assert.equal(control.tabIndex, 0)
    }
  }
  // 这里只核 DOM 顺序；JSDOM 不证明原生 Tab、真实 CSS 或 Windows 输入法行为。
})
