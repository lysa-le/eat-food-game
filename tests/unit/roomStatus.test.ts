import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveRoomStatus } from '../../src/game/roomStatus.ts'

const now = 1_000_000
const future = now + 60_000
const past = now - 60_000

test('open rooms keep their status', () => {
  assert.equal(effectiveRoomStatus('waiting', future, now), 'waiting')
  assert.equal(effectiveRoomStatus('ready', future, now), 'ready')
  assert.equal(effectiveRoomStatus('started', future, now), 'started')
  assert.equal(effectiveRoomStatus('closed', future, now), 'closed')
})

test('expired waiting/ready rooms count as closed', () => {
  assert.equal(effectiveRoomStatus('waiting', past, now), 'closed')
  assert.equal(effectiveRoomStatus('ready', past, now), 'closed')
  assert.equal(effectiveRoomStatus('waiting', now, now), 'closed')
})

test('a started game keeps its status after expiry', () => {
  assert.equal(effectiveRoomStatus('started', past, now), 'started')
})

test('missing or unknown status is null', () => {
  assert.equal(effectiveRoomStatus(undefined, future, now), null)
  assert.equal(effectiveRoomStatus('bogus', future, now), null)
})

test('no expiry field leaves the status as-is', () => {
  assert.equal(effectiveRoomStatus('waiting', null, now), 'waiting')
})
