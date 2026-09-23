import { JSDOM } from 'jsdom'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

require.extensions['.css'] = () => {}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/'
})

const { window } = dom

Object.defineProperty(globalThis, 'window', {
  value: window,
  configurable: true
})

Object.defineProperty(globalThis, 'document', {
  value: window.document,
  configurable: true
})

Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true
})

Object.defineProperty(globalThis, 'HTMLElement', {
  value: window.HTMLElement,
  configurable: true
})

Object.defineProperty(globalThis, 'Event', {
  value: window.Event,
  configurable: true
})

Object.defineProperty(globalThis, 'MutationObserver', {
  value: window.MutationObserver,
  configurable: true
})
