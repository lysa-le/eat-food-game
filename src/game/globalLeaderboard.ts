import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  addDoc,
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore'
import type { HighScoreEntry } from './highScore'

export const GLOBAL_LEADERBOARD_LIMIT = 10

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

/**
 * True once a real Firebase project is wired up via env vars (see
 * .env.example). Lets callers skip the global leaderboard UI and
 * network calls entirely when it isn't configured, rather than every
 * caller needing to handle a half-broken Firebase client.
 */
export function isGlobalLeaderboardConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  )
}

let db: Firestore | null = null

/** Lazily initializes the Firebase app — never called unless configured. */
function getDb(): Firestore {
  if (!db) {
    const app: FirebaseApp = initializeApp(firebaseConfig)
    db = getFirestore(app)
  }
  return db
}

const SCORES_COLLECTION = 'scores'

export type GameModeTag = 'solo' | 'together' | 'versus'

/**
 * Submits one score to the shared global leaderboard. Fire-and-forget
 * from the caller's side by design — a network hiccup here shouldn't
 * block or interrupt the local game-over flow (which already recorded
 * the score locally), so failures are logged, not surfaced to the
 * player.
 */
export async function submitGlobalScore(
  entry: HighScoreEntry,
  mode: GameModeTag,
): Promise<void> {
  if (!isGlobalLeaderboardConfigured()) return
  try {
    await addDoc(collection(getDb(), SCORES_COLLECTION), {
      initials: entry.initials.slice(0, 3),
      score: Math.max(0, Math.floor(entry.score)),
      mode,
      createdAt: serverTimestamp(),
    })
  } catch (err) {
    console.error('Failed to submit global score', err)
  }
}

/** Top-N scores across all players and modes, highest first. */
export async function fetchGlobalTopScores(
  count: number = GLOBAL_LEADERBOARD_LIMIT,
): Promise<HighScoreEntry[]> {
  if (!isGlobalLeaderboardConfigured()) return []
  try {
    const snapshot = await getDocs(
      query(
        collection(getDb(), SCORES_COLLECTION),
        orderBy('score', 'desc'),
        limit(count),
      ),
    )
    return snapshot.docs.map((doc) => {
      const data = doc.data() as { initials?: unknown; score?: unknown }
      return {
        initials: typeof data.initials === 'string' ? data.initials : '',
        score: typeof data.score === 'number' ? data.score : 0,
      }
    })
  } catch (err) {
    console.error('Failed to fetch global scores', err)
    return []
  }
}
