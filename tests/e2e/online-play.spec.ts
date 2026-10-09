import { expect, test } from '@playwright/test'
import { closePhones, addPoints, firebaseEnv, loseAllLives, panelTexts, startOnlineGame } from './helpers'

test.afterEach(closePhones)

test.skip(!firebaseEnv(), 'Online tests need Firebase config in .env.local')

test('Player 1 / Player 2 boxes: same layout on both phones, YOU on your own, live', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await expect.poll(() => panelTexts(host)).toEqual(['YOU Player 1 Score 0 Lv 1', 'Player 2 Score 0 Lv 1'])
  await expect.poll(() => panelTexts(guest)).toEqual(['Player 1 Score 0 Lv 1', 'YOU Player 2 Score 0 Lv 1'])
  await expect(host.locator('.camera-stage__score, .camera-stage__level-box')).toHaveCount(0)
  // The YOU tab sits on the box's top edge and stays on screen.
  for (const page of [host, guest]) {
    const tab = await page.locator('.camera-stage__side-hud-you').evaluate((e) => {
      const r = e.getBoundingClientRect()
      return { top: r.top, inView: r.top >= 0 && r.right <= innerWidth }
    })
    expect(tab.inView).toBe(true)
  }
  await addPoints(guest, 17)
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Player 2 Score 17 Lv 1')
  await expect.poll(async () => (await panelTexts(guest))[1]).toBe('YOU Player 2 Score 17 Lv 1')
  await loseAllLives(guest)
  await expect.poll(async () => (await panelTexts(host))[1]).toContain('Game Over')
})

test('out first: dimmed play screen, stakes banner, then result on both phones', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await addPoints(host, 87)
  await addPoints(guest, 64)
  await loseAllLives(host)

  await expect(host.locator('.camera-stage__dim')).toBeVisible()
  await expect(host.locator('.camera-stage__overlay')).toHaveCount(0)
  await expect.poll(async () => (await panelTexts(host))[0]).toContain('Game Over')
  const banner = host.locator('.camera-stage__hud--below-panels')
  await expect(banner).toContainText('Player 2 is still playing')
  await expect(banner).toContainText('Player 2 needs 24 more to win')
  // The banner sits clear of both (now lower) boxes.
  const overlap = await host.evaluate(() => {
    const b = document.querySelector('.camera-stage__hud--below-panels')!.getBoundingClientRect()
    return [...document.querySelectorAll('.camera-stage__side-hud')].some((el) => {
      const r = el.getBoundingClientRect()
      return r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom
    })
  })
  expect(overlap).toBe(false)
  await expect(host.getByRole('button', { name: 'Pause' })).toHaveCount(0)

  await addPoints(guest, 30)
  await expect(banner).toContainText('Player 2 is ahead')

  await loseAllLives(guest)
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__overlay--game-over h1')).toHaveText('Game Over')
  }
  // 94 vs 87: Player 2 wins.
  await expect(host.locator('.camera-stage__result-headline')).toHaveText('Player 2 Wins!')
  await expect(guest.locator('.camera-stage__result-headline')).toHaveText('You Win!')
  const rows = (page: typeof host) =>
    page.locator('.camera-stage__match-ranking li').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    )
  await expect.poll(() => rows(host)).toEqual(['1. Player 2 000094', '2. Player 1 000087'])
  await expect(host.locator('.camera-stage__match-ranking li').nth(1)).toHaveClass(/leaderboard-row--you/)
  // Note: Save is deliberately never pressed, so tests don't write to the
  // real leaderboard.
})

test('Play Again: both tap, a fresh round 2 starts in the same room', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await addPoints(host, 30)
  await addPoints(guest, 20)
  await loseAllLives(host)
  await loseAllLives(guest)
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__overlay--game-over h1')).toHaveText('Game Over')
  }

  await host.getByRole('button', { name: 'Play Again' }).click()
  await expect(host.getByRole('button', { name: 'Waiting for Player 2…' })).toBeDisabled()
  await expect(guest.getByText('Player 1 wants to play again')).toBeVisible()

  await guest.getByRole('button', { name: 'Play Again' }).click()
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__countdown')).toBeVisible({ timeout: 30_000 })
  }
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__overlay')).toHaveCount(0, { timeout: 30_000 })
  }
  // Fresh round: zero scores, full lives, and last round's Game Over is gone.
  await expect.poll(() => panelTexts(host)).toEqual(['YOU Player 1 Score 0 Lv 1', 'Player 2 Score 0 Lv 1'])
  await expect.poll(() => panelTexts(guest)).toEqual(['Player 1 Score 0 Lv 1', 'YOU Player 2 Score 0 Lv 1'])

  // Round 2 plays and finishes normally.
  await addPoints(guest, 9)
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Player 2 Score 9 Lv 1')
  await loseAllLives(guest)
  await loseAllLives(host)
  await expect(host.locator('.camera-stage__result-headline')).toHaveText('Player 2 Wins!')
})

test('leaving after a round: the other phone sees "Player N has left the game"', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await loseAllLives(host)
  await loseAllLives(guest)
  await expect(guest.locator('.camera-stage__overlay--game-over h1')).toHaveText('Game Over')
  await host.getByRole('button', { name: 'Return to menu' }).click()
  await expect(guest.getByText('Player 1 has quit the game')).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Play Again' })).toHaveCount(0)
})

test('idle friend stays "still playing"; a silent one has quit → You Win!', async ({ browser }) => {
  test.setTimeout(240_000)
  const { host, guest } = await startOnlineGame(browser)
  await addPoints(host, 20)
  await addPoints(guest, 90)
  await loseAllLives(host)
  // Guest idle for 36s: only heartbeats arrive.
  await host.waitForTimeout(36_000)
  await expect(host.locator('.camera-stage__hud--below-panels')).toContainText('Player 2 is still playing')
  await expect(host.getByRole('button', { name: 'Return to menu' })).toBeVisible()

  // Guest goes silent without closing the room (like a phone locking):
  // block its writes, then wait out the 30s.
  await guest.context().route('**/firestore.googleapis.com/**', (route) => route.abort())
  await expect(host.locator('.camera-stage__result-headline')).toHaveText('You Win!', { timeout: 60_000 })
  await expect(host.locator('.camera-stage__match-ranking li').nth(1)).toContainText('Quit')
  await expect(host.getByText('Player 2 has quit the game')).toBeVisible()
  await host.getByRole('button', { name: 'Return to menu' }).click()
  await expect(host.locator('.camera-stage__title')).toHaveText('Eat Food')
})

test('a paused player shows "Paused" in their box and in the waiting banner', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await guest.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Player 2 Score 0 Lv 1 Paused')
  await loseAllLives(host)
  await expect(host.locator('.camera-stage__hud--below-panels')).toContainText('Player 2 paused')
  await guest.getByRole('button', { name: 'Resume' }).click()
  await expect(host.locator('.camera-stage__hud--below-panels')).toContainText('Player 2 is still playing')
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Player 2 Score 0 Lv 1')
})

test('Quit from the pause screen: the other player sees it, keeps playing, and wins', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await addPoints(host, 10)
  await addPoints(guest, 50)
  await guest.getByRole('button', { name: 'Pause' }).click()
  await guest.getByRole('button', { name: 'Quit' }).click()
  await expect(guest.locator('.camera-stage__title')).toHaveText('Eat Food')

  await expect(host.getByText('Player 2 has quit the game')).toBeVisible()
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Player 2 Score 50 Lv 1 Quit')
  // Host keeps playing, then finishes: wins despite the lower score.
  await addPoints(host, 5)
  await loseAllLives(host)
  await expect(host.locator('.camera-stage__result-headline')).toHaveText('You Win!')
  const rows = await host.locator('.camera-stage__match-ranking li').allInnerTexts()
  expect(rows.map((r) => r.replace(/\s+/g, ' ').trim())).toEqual(['1. Player 1 000015', '2. Player 2 Quit'])
  await expect(host.getByRole('button', { name: 'Play Again' })).toHaveCount(0)
})

test('reloading the page mid-game quits it: the other player is told right away', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  const t0 = Date.now()
  await guest.reload()
  await expect(host.getByText('Player 2 has quit the game')).toBeVisible({ timeout: 15_000 })
  expect(Date.now() - t0).toBeLessThan(15_000)
  await expect.poll(async () => (await panelTexts(host))[1]).toContain('Quit')
})

test('Return to menu while out (other still playing) counts as quitting', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await loseAllLives(guest)
  await guest.getByRole('button', { name: 'Return to menu' }).click()
  await expect(guest.locator('.camera-stage__title')).toHaveText('Eat Food')
  await expect(host.getByText('Player 2 has quit the game')).toBeVisible()
  await loseAllLives(host)
  await expect(host.locator('.camera-stage__result-headline')).toHaveText('You Win!')
})
