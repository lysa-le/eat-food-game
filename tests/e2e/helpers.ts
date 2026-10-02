import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test'

/** Firestore writes/reads can be slow on a poor connection. */
const FIRESTORE_TIMEOUT = 60_000

/**
 * The face model + MediaPipe WASM (~10 MB) are downloaded once into
 * node_modules/.cache and served locally to every test "phone" — each
 * context otherwise starts with an empty cache and re-downloads them.
 */
const ASSET_CACHE = join('node_modules', '.cache', 'eat-food-e2e')
const CACHED_ASSETS = /storage\.googleapis\.com\/mediapipe-models\/|cdn\.jsdelivr\.net\/npm\/@mediapipe\//

async function serveCachedAssets(context: BrowserContext) {
  mkdirSync(ASSET_CACHE, { recursive: true })
  await context.route(CACHED_ASSETS, async (route) => {
    const url = route.request().url()
    const file = join(ASSET_CACHE, createHash('sha1').update(url).digest('hex'))
    if (!existsSync(file)) {
      const response = await fetch(url)
      if (!response.ok) return route.continue()
      writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    }
    const contentType = url.endsWith('.wasm')
      ? 'application/wasm'
      : url.endsWith('.js')
        ? 'text/javascript'
        : 'application/octet-stream'
    await route.fulfill({
      body: readFileSync(file),
      contentType,
      headers: { 'access-control-allow-origin': '*' },
    })
  })
}

/** Firebase config from .env.local, or null if it isn't set up. */
export function firebaseEnv(): Record<string, string> | null {
  if (!existsSync('.env.local')) return null
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.split('=').map((s) => s.trim())),
  )
  return env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID ? env : null
}

// Every phone opened by the current test. Each one runs a camera, face
// tracking and the game loop, so they must be closed after each test or
// they pile up and slow everything down (see closePhones).
const openPhones = new Set<BrowserContext>()

/** Closes every phone the test opened. Call from test.afterEach. */
export async function closePhones() {
  await Promise.all([...openPhones].map((context) => context.close()))
  openPhones.clear()
}

/** A fresh "phone": its own context, so two can play against each other.
 * navigator.share is stubbed to record the shared URL. */
export async function phone(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    ...options,
  })
  openPhones.add(context)
  context.on('close', () => openPhones.delete(context))
  await serveCachedAssets(context)
  await context.addInitScript(() => {
    Object.assign(navigator, {
      share: async (data: ShareData) => {
        ;(window as unknown as { __sharedUrl?: string }).__sharedUrl = data.url
      },
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (err) => {
    throw err
  })
  return page
}

/** Waits until face tracking has warmed up and Start is enabled. */
export async function waitForReady(page: Page) {
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({
    timeout: 150_000,
  })
}

/** Opens the app and waits for the menu to be ready. */
export async function openApp(page: Page, path = '') {
  await page.goto(path)
  await waitForReady(page)
}

/** Host creates an online room; returns the link it shared. */
export async function hostOnlineRoom(host: Page): Promise<string> {
  await openApp(host)
  await host.getByRole('button', { name: '2 Player' }).click()
  await host.getByRole('button', { name: 'Online' }).click()
  await expect(host.locator('.camera-stage__lobby-qr img')).toBeVisible({ timeout: FIRESTORE_TIMEOUT })
  await host.getByRole('button', { name: 'Share link' }).click()
  const link = await host.evaluate(
    () => (window as unknown as { __sharedUrl?: string }).__sharedUrl,
  )
  expect(link).toMatch(/\?room=[a-z0-9]{20}$/)
  return link!
}

/** Host + guest paired and playing an online game. */
export async function startOnlineGame(browser: Browser) {
  const host = await phone(browser)
  const link = await hostOnlineRoom(host)
  const guest = await phone(browser)
  await guest.goto(link)
  await expect(host.getByText('Player 2 joined ✓')).toBeVisible({ timeout: 150_000 })
  await host.getByRole('button', { name: 'Start', exact: true }).click()
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__overlay')).toHaveCount(0, { timeout: FIRESTORE_TIMEOUT })
    await expect(page.locator('.camera-stage__side-hud')).toHaveCount(2)
  }
  return { host, guest, roomId: new URL(link).searchParams.get('room')! }
}

type Debug = { addPoints: (n: number) => void; loseLife: () => void }

/** Scores points through the dev-only test hook. */
export const addPoints = (page: Page, points: number) =>
  page.evaluate((n) => (window as unknown as { __eatFoodDebug: Debug }).__eatFoodDebug.addPoints(n), points)

/** Loses every life through the dev-only test hook. */
export const loseAllLives = (page: Page) =>
  page.evaluate(() => {
    const debug = (window as unknown as { __eatFoodDebug: Debug }).__eatFoodDebug
    for (let i = 0; i < 3; i++) debug.loseLife()
  })

/** The two HUD boxes' text (Same Screen or Online). */
export const panelTexts = (page: Page) =>
  page.locator('.camera-stage__side-hud').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
  )
