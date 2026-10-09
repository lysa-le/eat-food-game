import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefersLongPolling } from '../../src/game/firestoreTransport.ts'

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
}

test('long polling on every iOS browser (all WebKit)', () => {
  assert.equal(prefersLongPolling(UA.iphoneSafari, 'iPhone', 5), true)
  assert.equal(prefersLongPolling(UA.iphoneChrome, 'iPhone', 5), true)
  assert.equal(prefersLongPolling(UA.ipadAsMac, 'MacIntel', 5), true)
})

test('long polling on desktop Safari', () => {
  assert.equal(prefersLongPolling(UA.macSafari, 'MacIntel', 0), true)
})

test('streaming everywhere else', () => {
  assert.equal(prefersLongPolling(UA.macChrome, 'MacIntel', 0), false)
  assert.equal(prefersLongPolling(UA.androidChrome, 'Linux armv8l', 5), false)
  assert.equal(prefersLongPolling(UA.edge, 'Win32', 0), false)
})
