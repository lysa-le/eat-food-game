import { defineConfig, devices } from '@playwright/test'

const PORT = 4810

/**
 * Browser tests (`npm run test:e2e`). They run against the dev server
 * (which this starts) because they use the dev-only `__eatFoodDebug`
 * hook to score and lose lives — Chromium's fake camera can't chomp.
 * Online tests use the real Firebase project from .env.local and skip
 * themselves without it.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // Each phone downloads the ~4 MB face model, and online tests share one
  // Firestore project — one at a time keeps both predictable.
  workers: 1,
  // Online tests depend on real network + Firestore round trips; one
  // retry absorbs a blip, and Playwright still reports those as flaky.
  retries: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    ...devices['iPhone 13'],
    // iPhone 13 defaults to WebKit; the fake camera flags are Chromium's.
    browserName: 'chromium',
    defaultBrowserType: 'chromium',
    baseURL: `http://localhost:${PORT}/`,
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
    // Vite forwards every browser console line (MediaPipe is chatty).
    stdout: 'ignore',
  },
})
