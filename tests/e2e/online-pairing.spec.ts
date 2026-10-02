import { expect, test } from '@playwright/test'
import { closePhones, firebaseEnv, hostOnlineRoom, phone, startOnlineGame } from './helpers'

test.afterEach(closePhones)

test.skip(!firebaseEnv(), 'Online tests need Firebase config in .env.local')

test('host waits; guest joins; leave and rejoin; room full', async ({ browser }) => {
  const host = await phone(browser)
  const link = await hostOnlineRoom(host)
  await expect(host.getByText('Player 2: waiting…')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()

  let guest = await phone(browser)
  await guest.goto(link)
  await expect(guest.getByText("Connected! You're Player 2. Waiting for Player 1 to start…")).toBeVisible({ timeout: 150_000 })
  await expect(host.getByText('Player 2 joined ✓')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()

  await guest.getByRole('button', { name: 'Leave' }).click()
  await expect(host.getByText('Player 2: waiting…')).toBeVisible()
  await guest.context().close()

  guest = await phone(browser)
  await guest.goto(link)
  await expect(guest.getByText('Connected!')).toBeVisible({ timeout: 150_000 })
  await expect(host.getByText('Player 2 joined ✓')).toBeVisible()

  const third = await phone(browser)
  await third.goto(link)
  await expect(third.getByText('This game already has 2 players.')).toBeVisible({ timeout: 60_000 })
})

test('Start counts down on both phones; late arrival sees "already started"', async ({ browser }) => {
  const host = await phone(browser)
  const link = await hostOnlineRoom(host)
  const guest = await phone(browser)
  await guest.goto(link)
  await expect(host.getByText('Player 2 joined ✓')).toBeVisible({ timeout: 150_000 })
  await host.getByRole('button', { name: 'Start', exact: true }).click()
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__countdown')).toBeVisible({ timeout: 30_000 })
  }
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__overlay')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator('.camera-stage__side-hud')).toHaveCount(2)
  }
  const late = await phone(browser)
  await late.goto(link)
  await expect(late.getByText('This game already started.')).toBeVisible({ timeout: 60_000 })
})

test('host only counts down once the server confirms Start', async ({ browser }) => {
  // Play-test bug: an old app version's Start was rejected by the rules,
  // but the host's own optimistic "started" made it count down and play
  // while the guest waited forever. Hold the host's writes back so Start
  // stays unconfirmed, then let it through.
  const host = await phone(browser)
  const link = await hostOnlineRoom(host)
  const guest = await phone(browser)
  await guest.goto(link)
  await expect(host.getByText('Player 2 joined ✓')).toBeVisible({ timeout: 150_000 })

  const writes = '**/google.firestore.v1.Firestore/Write/**'
  await host.context().route(writes, (route) => route.abort())
  await host.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(host.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  await host.waitForTimeout(8_000)
  await expect(host.locator('.camera-stage__countdown')).toHaveCount(0)
  await expect(guest.locator('.camera-stage__countdown')).toHaveCount(0)

  await host.context().unroute(writes)
  for (const page of [host, guest]) {
    await expect(page.locator('.camera-stage__countdown')).toBeVisible({ timeout: 90_000 })
  }
})

test('host Cancel closes the room for a waiting guest', async ({ browser }) => {
  const host = await phone(browser)
  const link = await hostOnlineRoom(host)
  const guest = await phone(browser)
  await guest.goto(link)
  await expect(guest.getByText('Connected!')).toBeVisible({ timeout: 150_000 })
  await host.getByRole('button', { name: 'Cancel' }).click()
  await expect(guest.getByText('This game is no longer open.')).toBeVisible()
  await expect(host.locator('.camera-stage__title')).toHaveText('Eat Food')
})

test('the shared link is removed from the address bar after opening it', async ({ browser }) => {
  const { guest } = await startOnlineGame(browser)
  expect(new URL(guest.url()).searchParams.has('room')).toBe(false)
})
