import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
/** Short commit id, shown next to the credit so two devices can be
 * checked for the same version. */
function appVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  // GitHub Pages serves the site from /eat-food-game/ (set by the deploy
  // workflow); local dev and preview stay at /.
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    VitePWA({
      // Apply updates ourselves, only on the main menu — see src/appUpdate.ts.
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Eat Food',
        short_name: 'Eat Food',
        description:
          'Chomp fruits & veggies with your real mouth via webcam — avoid junk food and hazards!',
        theme_color: '#fb923c',
        background_color: '#1e1b4b',
        display: 'standalone',
        start_url: '.',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Only precache the app shell (JS/CSS/HTML) at install time — the
        // game's many sprite/audio files (including some unused leftover
        // asset-pack files under public/) are cached on-demand instead,
        // via runtimeCaching below, so the service worker doesn't have to
        // download everything up front just to become installable.
        globPatterns: ['**/*.{js,css,html,ico}'],
        runtimeCaching: [
          {
            // This game's own sprite/audio assets, cached as visited.
            // The CDN-hosted rules below take precedence for their hosts,
            // so scoping this one by extension alone is sufficient.
            urlPattern: /\.(png|gif|mp3|svg)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'game-assets' },
          },
          {
            // MediaPipe face-tracking WASM runtime + model, both from a
            // version-pinned URL — safe to cache aggressively long-term.
            urlPattern: ({ url }: { url: URL }) =>
              url.hostname === 'cdn.jsdelivr.net' ||
              url.hostname === 'storage.googleapis.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // Google Fonts stylesheet + font files (the retro pixel font).
            urlPattern: ({ url }: { url: URL }) =>
              url.hostname === 'fonts.googleapis.com' ||
              url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
})
