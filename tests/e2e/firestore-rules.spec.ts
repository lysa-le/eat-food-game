import { expect, test } from '@playwright/test'
import { initializeApp } from 'firebase/app'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { firebaseEnv } from './helpers'

/**
 * Checks the *published* firestore.rules against the real project — run
 * after publishing rule changes in the Firebase Console. Leaves one small
 * closed test room behind, which the in-game cleanup deletes after ~30h.
 */
const env = firebaseEnv()
test.skip(!env, 'Rules tests need Firebase config in .env.local')

const H = 60 * 60 * 1000

test('published rules allow and deny the right writes', async () => {
  const db = getFirestore(
    initializeApp({
      apiKey: env!.VITE_FIREBASE_API_KEY,
      authDomain: env!.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env!.VITE_FIREBASE_PROJECT_ID,
      appId: env!.VITE_FIREBASE_APP_ID,
    }),
  )
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'allowed',
      (e: { code?: string }) => e.code ?? 'error',
    )
  const id = 'rulestest' + Math.random().toString(36).slice(2, 14)
  const room = doc(db, 'rooms', id)
  const player = (role: string) => doc(db, 'rooms', id, 'players', role)
  const state = (lives = 3, round = 1) => ({ score: 5, lives, level: 1, out: false, round, updatedAt: serverTimestamp() })
  const rooms = collection(db, 'rooms')

  // Soft expects: one run reports every rule that's wrong, not just the first.
  const run = async (name: string, p: () => Promise<unknown>, want: 'allowed' | 'permission-denied') => {
    expect.soft(await outcome(p()), name).toBe(want)
  }

  await run('create valid room', () => setDoc(room, { status: 'waiting', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 6 * H) }), 'allowed')
  await run('create already-expired room', () => setDoc(doc(db, 'rooms', id + 'x'), { status: 'waiting', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() - H) }), 'permission-denied')
  await run('create room expiring after 7h', () => setDoc(doc(db, 'rooms', id + 'y'), { status: 'waiting', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 8 * H) }), 'permission-denied')
  await run('get room by id', () => getDoc(room), 'allowed')
  await run('delete fresh room', () => deleteDoc(room), 'permission-denied')
  await run('list all rooms', () => getDocs(query(rooms, limit(10))), 'permission-denied')
  await run('cleanup query (25h+ expired, limit 10)', () => getDocs(query(rooms, where('expiresAt', '<', Timestamp.fromMillis(Date.now() - 25 * H)), limit(10))), 'allowed')
  await run('list rooms only 1h expired', () => getDocs(query(rooms, where('expiresAt', '<', Timestamp.fromMillis(Date.now() - H)), limit(10))), 'permission-denied')
  await run('player state before the game starts', () => setDoc(player('host'), state()), 'permission-denied')
  await run('start before anyone joined', () => updateDoc(room, { status: 'started', startedAt: serverTimestamp() }), 'permission-denied')
  await run('join (waiting → ready)', () => updateDoc(room, { status: 'ready' }), 'allowed')
  await run('change expiresAt', () => updateDoc(room, { expiresAt: Timestamp.fromMillis(Date.now() + 6 * H) }), 'permission-denied')
  await run('start without round 1', () => updateDoc(room, { status: 'started', startedAt: serverTimestamp() }), 'permission-denied')
  await run('start (ready → started, round 1)', () => updateDoc(room, { status: 'started', startedAt: serverTimestamp(), round: 1 }), 'allowed')
  await run('host player state (round 1)', () => setDoc(player('host'), state()), 'allowed')
  await run('player state for the wrong round', () => setDoc(player('host'), state(3, 2)), 'permission-denied')
  await run('player state with 9 lives', () => setDoc(player('guest'), state(9)), 'permission-denied')
  await run('unknown player role', () => setDoc(player('spectator'), state()), 'permission-denied')
  await run('next round before both tapped Play Again', () => updateDoc(room, { round: 2, hostAgain: false, guestAgain: false, startedAt: serverTimestamp() }), 'permission-denied')
  await run('host taps Play Again', () => updateDoc(room, { hostAgain: true }), 'allowed')
  await run('Play Again tap that sets false', () => updateDoc(room, { guestAgain: false }), 'permission-denied')
  await run('guest taps Play Again', () => updateDoc(room, { guestAgain: true }), 'allowed')
  await run('skip a round (1 → 3)', () => updateDoc(room, { round: 3, hostAgain: false, guestAgain: false, startedAt: serverTimestamp() }), 'permission-denied')
  await run('next round (1 → 2), taps cleared', () => updateDoc(room, { round: 2, hostAgain: false, guestAgain: false, startedAt: serverTimestamp() }), 'allowed')
  await run('player state for round 2', () => setDoc(player('guest'), state(3, 2)), 'allowed')
  await run('reopen a started room', () => updateDoc(room, { status: 'waiting' }), 'permission-denied')
  await run('close a started room', () => updateDoc(room, { status: 'closed' }), 'allowed')
  await run('leaderboard read', () => getDocs(query(collection(db, 'scores'), limit(5))), 'allowed')
  await run('leaderboard entry with 4-letter initials', () => setDoc(doc(collection(db, 'scores')), { initials: 'abcd', score: 1, mode: 'solo', createdAt: serverTimestamp() }), 'permission-denied')
})
