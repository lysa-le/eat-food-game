import { expect, test } from '@playwright/test'
import { closePhones, addPoints, firebaseEnv, loseAllLives, panelTexts, startOnlineGame } from './helpers'

test.afterEach(closePhones)

test.skip(!firebaseEnv(), 'Online tests need Firebase config in .env.local')

test('You / Friend boxes follow the other phone live', async ({ browser }) => {
  const { host, guest } = await startOnlineGame(browser)
  await expect.poll(() => panelTexts(host)).toEqual(['You Score 0 Lv 1', 'Friend Score 0 Lv 1'])
  await expect(host.locator('.camera-stage__score, .camera-stage__level-box')).toHaveCount(0)
  await addPoints(guest, 17)
  await expect.poll(async () => (await panelTexts(host))[1]).toBe('Friend Score 17 Lv 1')
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
  await expect(banner).toContainText('Friend is still playing')
  await expect(banner).toContainText('Friend needs 24 more to win')
  await expect(host.getByRole('button', { name: 'Pause' })).toHaveCount(0)

  await addPoints(guest, 30)
  await expect(banner).toContainText('Friend is ahead')

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

test('idle friend stays "still playing"; a closed one has "left the game"', async ({ browser }) => {
  test.setTimeout(240_000)
  const { host, guest } = await startOnlineGame(browser)
  await addPoints(host, 20)
  await loseAllLives(host)
  // Guest idle for 36s: only heartbeats arrive.
  await host.waitForTimeout(36_000)
  await expect(host.locator('.camera-stage__hud--below-panels')).toContainText('Friend is still playing')

  await guest.context().close()
  const card = host.locator('.camera-stage__hud--center')
  await expect(card).toContainText('Friend has left the game', { timeout: 45_000 })
  const offset = await card.evaluate((e) => {
    const r = e.getBoundingClientRect()
    return Math.round(Math.abs(r.left + r.width / 2 - innerWidth / 2) + Math.abs(r.top + r.height / 2 - innerHeight / 2))
  })
  expect(offset).toBeLessThanOrEqual(2)
  await card.getByRole('button', { name: 'Return to menu' }).click()
  await expect(host.locator('.camera-stage__title')).toHaveText('Eat Food')
})
