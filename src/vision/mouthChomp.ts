import type { Classifications, NormalizedLandmark } from '@mediapipe/tasks-vision'

// Inner-lip vertical center points and mouth corners, used only for
// tracking mouth *position* on screen (see computeMouthCenter). Mouth
// *openness* comes from blendshapes instead — see computeJawOpenScore.
const UPPER_INNER_LIP = 13
const LOWER_INNER_LIP = 14
const LEFT_MOUTH_CORNER = 61
const RIGHT_MOUTH_CORNER = 291

const JAW_OPEN_CATEGORY = 'jawOpen'

/**
 * Head-pose-normalized mouth-open score in [0, 1], from Face Landmarker's
 * blendshapes (ARKit-style expression coefficients). A raw landmark
 * distance ratio (vertical lip gap / mouth width) looks convincing
 * head-on but falls apart at an angle or near frame edges, since
 * perspective foreshortening distorts the mouth's projected 2D shape.
 * Blendshapes are derived from the fitted 3D face model with head pose
 * already factored out, so this holds up across angle and position.
 *
 * Takes one face's Classifications (i.e. result.faceBlendshapes[i] for
 * face i) — with multi-face tracking, result.faceBlendshapes has one
 * entry per detected face, so the caller picks which face.
 */
export function computeJawOpenScore(
  blendshapes: Classifications | undefined,
): number {
  const categories = blendshapes?.categories ?? []
  return (
    categories.find((c) => c.categoryName === JAW_OPEN_CATEGORY)?.score ?? 0
  )
}

/** Mouth center in normalized [0,1] video-frame coordinates. */
export function computeMouthCenter(landmarks: NormalizedLandmark[]): {
  x: number
  y: number
} {
  const points = [
    landmarks[UPPER_INNER_LIP],
    landmarks[LOWER_INNER_LIP],
    landmarks[LEFT_MOUTH_CORNER],
    landmarks[RIGHT_MOUTH_CORNER],
  ]
  const x = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length
  return { x, y }
}

interface Point {
  x: number
  y: number
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Assigns a stable "Player 1" / "Player 2" identity to detected faces
 * across frames, for co-op. Face Landmarker doesn't expose a persistent
 * face ID, and detected-face order isn't guaranteed stable frame to
 * frame, so re-sorting purely by left/right position every frame would
 * let identity flip whenever the two players' relative positions cross
 * (or even just from detection jitter). Instead, this matches each
 * frame's detected faces against each player's *last known* position —
 * whichever pairing has the lower total movement wins — so identity
 * stays put once assigned, the same way real face/object trackers work.
 *
 * Takes mouth positions already in canvas pixel space (consistent units
 * are all that matter here; canvas pixels are what's already computed
 * for rendering/hit-testing anyway). Only the first two points are used
 * per call, matching numFaces: 2.
 */
export class TwoPlayerTracker {
  private lastPosition: [Point | null, Point | null] = [null, null]

  /** Returns [player1FaceIndex, player2FaceIndex] into `mouthPositions`. */
  assign(mouthPositions: Point[]): [number | null, number | null] {
    if (mouthPositions.length === 0) {
      return [null, null]
    }

    if (mouthPositions.length === 1) {
      const [point] = mouthPositions
      const [p1, p2] = this.lastPosition
      // If only Player 2 has been seen so far (Player 1 stepped out
      // after Player 2 joined), keep matching this face to whichever
      // slot it's actually closer to instead of always defaulting to
      // Player 1.
      if (p2 && (!p1 || distance(point, p2) < distance(point, p1))) {
        this.lastPosition[1] = point
        return [null, 0]
      }
      this.lastPosition[0] = point
      return [0, null]
    }

    const [a, b] = mouthPositions
    const [p1, p2] = this.lastPosition
    if (p1 && p2) {
      const costDirect = distance(a, p1) + distance(b, p2)
      const costSwapped = distance(a, p2) + distance(b, p1)
      if (costSwapped < costDirect) {
        this.lastPosition = [b, a]
        return [1, 0]
      }
      this.lastPosition = [a, b]
      return [0, 1]
    }

    // No prior assignment yet — initialize by on-screen left/right
    // position. The canvas is CSS-mirrored (scaleX(-1)) for display, so
    // a *larger* x here actually ends up on the *left* of the screen —
    // that becomes Player 1.
    if (a.x >= b.x) {
      this.lastPosition = [a, b]
      return [0, 1]
    }
    this.lastPosition = [b, a]
    return [1, 0]
  }

  reset(): void {
    this.lastPosition = [null, null]
  }
}

export interface ChompThresholds {
  openThreshold: number
  closeThreshold: number
  /**
   * Minimum time (ms) the mouth must stay above openThreshold before a
   * subsequent close counts as a chomp. Talking flickers the mouth open
   * for very short bursts; a deliberate chomp holds it open longer. This
   * is what separates the two, since both cross the same ratio.
   */
  minOpenDurationMs: number
}

// Lowered from the original 0.55/0.2 after playtest feedback that a full
// wide-open chomp was uncomfortable to repeat (jaw strain/headache) —
// same hysteresis ratio, just requiring a smaller mouth-opening overall.
export const DEFAULT_CHOMP_THRESHOLDS: ChompThresholds = {
  openThreshold: 0.4,
  closeThreshold: 0.15,
  minOpenDurationMs: 80,
}

/**
 * Tracks mouth open/closed state with hysteresis (openThreshold >
 * closeThreshold) so noise hovering near one cutoff doesn't register as
 * repeated chomps. A chomp fires on the open -> closed transition, i.e.
 * the mouth snapping shut, but only if the mouth was held open for at
 * least minOpenDurationMs first (filters out fast talking movements).
 */
export class ChompDetector {
  private isOpen = false
  private openedAt = 0
  private thresholds: ChompThresholds

  constructor(thresholds: ChompThresholds = DEFAULT_CHOMP_THRESHOLDS) {
    this.thresholds = thresholds
  }

  /**
   * Feed the current frame's jaw-open score and timestamp (ms, e.g.
   * performance.now()); returns true iff a chomp fired now.
   */
  update(score: number, timestampMs: number): boolean {
    const { openThreshold, closeThreshold, minOpenDurationMs } =
      this.thresholds
    if (!this.isOpen && score >= openThreshold) {
      this.isOpen = true
      this.openedAt = timestampMs
      return false
    }
    if (this.isOpen && score <= closeThreshold) {
      this.isOpen = false
      return timestampMs - this.openedAt >= minOpenDurationMs
    }
    return false
  }

  get mouthIsOpen(): boolean {
    return this.isOpen
  }
}
