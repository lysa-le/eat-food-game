import { expect, test } from '@playwright/test'
import { closePhones, addPoints, loseAllLives, openApp, panelTexts, phone } from './helpers'

test.afterEach(closePhones)

test('main menu: 1 Player / 2 Player / Start, no HUD boxes', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await expect(page.locator('.camera-stage__overlay button')).toHaveText(['1 Player', '2 Player', 'Start'])
  await expect(page.locator('.camera-stage__score, .camera-stage__level-box, .camera-stage__side-hud')).toHaveCount(0)
})

test('2 Player opens Online / Same Screen / Cancel; Cancel goes back', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await page.getByRole('button', { name: '2 Player' }).click()
  await expect(page.locator('.camera-stage__overlay h1')).toHaveText('2 Player')
  await expect(page.locator('.camera-stage__overlay button')).toHaveText(['Online', 'Same Screen', 'Cancel'])
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.camera-stage__overlay button')).toHaveText(['1 Player', '2 Player', 'Start'])
})

test('Same Screen starts split screen with Player 1 / Player 2 boxes', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await page.getByRole('button', { name: '2 Player' }).click()
  await page.getByRole('button', { name: 'Same Screen' }).click()
  await expect(page.locator('.camera-stage__overlay')).toHaveCount(0)
  await expect.poll(() => panelTexts(page)).toEqual(['Player 1 Score 0 Lv 1', 'Player 2 Score 0 Lv 1'])
})

test('1 Player: Score/Level boxes while playing; end screen after 3 lives', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.locator('.camera-stage__score')).toBeVisible()
  await expect(page.locator('.camera-stage__level-box')).toBeVisible()
  await addPoints(page, 12)
  await expect(page.locator('.camera-stage__score')).toContainText('12')
  await loseAllLives(page)
  const end = page.locator('.camera-stage__overlay--game-over')
  await expect(end.locator('h1')).toHaveText('Game Over')
  await expect(end).toContainText('Final score: 12')
  await expect(end.getByRole('button', { name: 'Return to menu' })).toBeVisible()
  await expect(end.getByRole('button', { name: 'Play Again' })).toHaveCount(0)
  await end.getByRole('button', { name: 'Return to menu' }).click()
  await expect(page.locator('.camera-stage__title')).toHaveText('Eat Food')
})

test('Paused screen: Quit returns to the main menu with the camera running', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.camera-stage__overlay h1')).toHaveText('Paused')
  await page.getByRole('button', { name: 'Quit' }).click()
  await expect(page.locator('.camera-stage__title')).toHaveText('Eat Food')
  // The draw loop restarted: the camera frame keeps changing.
  const frame = () => page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL().length)
  const a = await frame()
  await page.waitForTimeout(1500)
  const b = await frame()
  expect(a).not.toBe(b)
})

test('pause button uses the drawn icon, not an emoji', async ({ browser }) => {
  const page = await phone(browser)
  await openApp(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  const pause = page.getByRole('button', { name: 'Pause' })
  await expect(pause.locator('svg')).toHaveCount(1)
  await expect(pause).toHaveText('')
})
