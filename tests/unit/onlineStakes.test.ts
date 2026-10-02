import assert from 'node:assert/strict'
import { test } from 'node:test'
import { friendStakesText, onlineMatchResult } from '../../src/game/onlineStakes.ts'

test('stakes while the other player is still playing', () => {
  assert.equal(friendStakesText(87, 64, 2), 'Player 2 needs 24 more to win')
  assert.equal(friendStakesText(50, 64, 2), 'Player 2 is ahead')
  assert.equal(friendStakesText(40, 40, 1), 'Player 1 needs 1 more to win')
  assert.equal(friendStakesText(0, 0, 1), 'Player 1 needs 1 more to win')
})

const summary = (r: ReturnType<typeof onlineMatchResult>) =>
  `${r.headline} | ` +
  r.rows
    .map((w) => `${w.rank}. P${w.playerNumber}${w.isYou ? '(you)' : ''} ${w.score}`)
    .join(' / ')

test('result: higher score wins, from either phone', () => {
  assert.equal(
    summary(onlineMatchResult('host', { score: 87 }, { score: 64 })),
    'You Win! | 1. P1(you) 87 / 2. P2 64',
  )
  assert.equal(
    summary(onlineMatchResult('guest', { score: 64 }, { score: 87 })),
    'Player 1 Wins! | 1. P1 87 / 2. P2(you) 64',
  )
  assert.equal(
    summary(onlineMatchResult('guest', { score: 90 }, { score: 87 })),
    'You Win! | 1. P2(you) 90 / 2. P1 87',
  )
  assert.equal(
    summary(onlineMatchResult('host', { score: 10 }, { score: 40 })),
    'Player 2 Wins! | 1. P2 40 / 2. P1(you) 10',
  )
})

test('result: a tie shares rank 1, Player 1 listed first', () => {
  assert.equal(
    summary(onlineMatchResult('host', { score: 50 }, { score: 50 })),
    "It's a Tie! | 1. P1(you) 50 / 1. P2 50",
  )
  assert.equal(
    summary(onlineMatchResult('guest', { score: 50 }, { score: 50 })),
    "It's a Tie! | 1. P1 50 / 1. P2(you) 50",
  )
})
