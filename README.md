# Eat Food

Chomp fruit & veggies with your real mouth via your camera — avoid junk
food and hazards!

**Play:** https://lysa-le.github.io/eat-food-game/ (works on desktop and
phones; on a phone, use *Add to Home Screen* to install it like an app).

## Modes

- **1 Player** — one shared score. Play solo, or a friend can lean into
  frame at any time and join as Player 2.
- **2 Player** — split screen, each player has their own score, level
  and lives.

Open your mouth wide and close it on food to eat it. Fruit & veggies
score points, junk food costs points, onigiri is a bonus, and beetles
cost a life.

## Run locally

```sh
npm ci
npm run dev
```

The camera needs a secure context: `localhost` works, but opening the
dev server from another device on your network needs HTTPS.

### Global leaderboard (optional)

The top-5 leaderboard uses Firebase Firestore. Copy `.env.example` to
`.env.local` and fill in your Firebase web app config. Without it the
game runs normally and the leaderboard is hidden.

Firestore security rules live in [`firestore.rules`](firestore.rules).
Publish changes to them in the Firebase Console (Firestore → Rules).

## Tests

```sh
npm run test:unit   # game logic, no browser (< 1s)
npx playwright install chromium   # once
npm run test:e2e    # browser tests (~4 min)
npm test            # both
```

The browser tests start the dev server and use a dev-only hook
(`window.__eatFoodDebug`, stripped from production builds) to score and
lose lives, since Chromium's fake camera can't chomp. Online and
Firestore-rules tests use the real Firebase project from `.env.local`
(they skip without it) and never press Save, so they don't touch the
real leaderboard. Run `firestore-rules.spec.ts` after publishing rule
changes.

## Deploy

Every push to `main` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The
Firebase config comes from the repo's Actions secrets.

## Tech

React + TypeScript + Vite, MediaPipe Face Landmarker for mouth tracking,
Firebase Firestore for the leaderboard, and a PWA service worker so it
installs on phones.
