const GOOD_EAT_SOUND_URL = `${import.meta.env.BASE_URL}carrotnom.mp3`
const LEVEL_UP_SOUND_URL = `${import.meta.env.BASE_URL}sound-retro-level-up.mp3`

let audioContext: AudioContext | null = null
const sampleBufferCache = new Map<string, Promise<AudioBuffer>>()

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

function resumeIfSuspended(ctx: AudioContext): void {
  if (ctx.state === 'suspended') {
    void ctx.resume()
  }
}

function loadSampleBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let promise = sampleBufferCache.get(url)
  if (!promise) {
    promise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
    sampleBufferCache.set(url, promise)
  }
  return promise
}

function playSample(url: string): void {
  const ctx = getAudioContext()
  resumeIfSuspended(ctx)
  loadSampleBuffer(ctx, url).then((buffer) => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
  })
}

// Kick off fetch + decode for both samples as soon as this module loads,
// so the first playback of either doesn't stall on network/decode latency.
loadSampleBuffer(getAudioContext(), GOOD_EAT_SOUND_URL)
loadSampleBuffer(getAudioContext(), LEVEL_UP_SOUND_URL)

/** Recorded sample: eating a good (fruit/veggie) item. */
export function playGoodEat(): void {
  playSample(GOOD_EAT_SOUND_URL)
}

/** Recorded sample: leveling up. */
export function playLevelUp(): void {
  playSample(LEVEL_UP_SOUND_URL)
}

/** Synthesized: a dull, deflating "womp" for getting hit by a hazard. */
export function playHazardHit(): void {
  const ctx = getAudioContext()
  resumeIfSuspended(ctx)
  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(220, now)
  osc.frequency.exponentialRampToValueAtTime(90, now + 0.35)
  gain.gain.setValueAtTime(0.001, now)
  gain.gain.linearRampToValueAtTime(0.25, now + 0.03)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.42)
}

/** Synthesized: a bright ascending chime for eating a rare bonus item. */
export function playBonusEat(): void {
  const ctx = getAudioContext()
  resumeIfSuspended(ctx)
  const now = ctx.currentTime
  const notes = [523.25, 659.25, 783.99, 1046.5]

  notes.forEach((freq, i) => {
    const startTime = now + i * 0.06
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, startTime)
    gain.gain.setValueAtTime(0, startTime)
    gain.gain.linearRampToValueAtTime(0.25, startTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(startTime)
    osc.stop(startTime + 0.27)
  })
}

/** Synthesized: a short descending 3-note "game over" jingle. */
export function playGameOver(): void {
  const ctx = getAudioContext()
  resumeIfSuspended(ctx)
  const now = ctx.currentTime
  const notes = [392, 329.63, 261.63]

  notes.forEach((freq, i) => {
    const startTime = now + i * 0.22
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(freq, startTime)
    gain.gain.setValueAtTime(0, startTime)
    gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(startTime)
    osc.stop(startTime + 0.42)
  })
}
