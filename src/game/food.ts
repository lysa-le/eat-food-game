export type FoodCategory = 'good' | 'junk' | 'bonus' | 'hazard'

export interface FoodItem {
  id: number
  category: FoodCategory
  /** Position as a fraction of canvas width/height, in [0, 1]. Storing
   * position this way (rather than raw pixels) means food stays exactly
   * where it visually was, proportionally, if the canvas is resized. */
  xFrac: number
  yFrac: number
  spawnedAt: number
  /** null = never expires on its own (only "good" food). */
  expiresAt: number | null
  /** URL of this item's pixel-art sprite (see public/Food_16x16, Junk_16x16, Misc/Food, BeetlePack). */
  sprite: string
  points: number
}

export interface ResolvedFood extends FoodItem {
  x: number
  y: number
  radius: number
}

interface CategoryConfig {
  sprites: string[]
  points: number
  /** null = persistent (only "good" food). */
  lifetimeMs: number | null
  /** Lifetime shrinks by this factor per level (1 = constant). Only
   * meaningful when lifetimeMs is set. */
  lifetimeDecayPerLevel: number
  minLifetimeMs: number
  baseSpawnIntervalMs: number
  /** Spawn interval shrinks by this factor per level (1 = constant). */
  spawnIntervalDecayPerLevel: number
  minSpawnIntervalMs: number
  maxActive: number
}

// BASE_URL is '/' locally and '/eat-food-game/' on GitHub Pages.
const FOOD_SPRITE_DIR = `${import.meta.env.BASE_URL}Food_16x16`
const JUNK_SPRITE_DIR = `${import.meta.env.BASE_URL}Junk_16x16`
const BONUS_SPRITE_DIR = `${import.meta.env.BASE_URL}Misc/Food`
const BEETLE_SPRITE_DIR = `${import.meta.env.BASE_URL}BeetlePack`

const CATEGORY_CONFIG: Record<FoodCategory, CategoryConfig> = {
  good: {
    sprites: [
      `${FOOD_SPRITE_DIR}/red_apple.png`,
      `${FOOD_SPRITE_DIR}/banana.png`,
      `${FOOD_SPRITE_DIR}/watermelon2.png`,
      `${FOOD_SPRITE_DIR}/red_grape.png`,
      `${FOOD_SPRITE_DIR}/cabbage.png`,
    ],
    points: 1,
    lifetimeMs: null,
    lifetimeDecayPerLevel: 1,
    minLifetimeMs: 0,
    baseSpawnIntervalMs: 1800,
    spawnIntervalDecayPerLevel: 0.85,
    minSpawnIntervalMs: 500,
    maxActive: 10,
  },
  junk: {
    sprites: [
      `${JUNK_SPRITE_DIR}/cookies.png`,
      `${JUNK_SPRITE_DIR}/marshmallows.png`,
      `${JUNK_SPRITE_DIR}/potatochip_yellow.png`,
      `${JUNK_SPRITE_DIR}/soft_drink_blue.png`,
      `${JUNK_SPRITE_DIR}/strawberry_ice_cream.png`,
    ],
    points: -1,
    lifetimeMs: 4000,
    lifetimeDecayPerLevel: 1,
    minLifetimeMs: 4000,
    baseSpawnIntervalMs: 3500,
    spawnIntervalDecayPerLevel: 0.93,
    minSpawnIntervalMs: 1500,
    maxActive: 3,
  },
  bonus: {
    sprites: [
      `${BONUS_SPRITE_DIR}/onigiri_1.png`,
      `${BONUS_SPRITE_DIR}/cake_redvelvet.png`,
    ],
    points: 5,
    lifetimeMs: 2200,
    lifetimeDecayPerLevel: 0.92,
    minLifetimeMs: 1100,
    baseSpawnIntervalMs: 9000,
    spawnIntervalDecayPerLevel: 1,
    minSpawnIntervalMs: 9000,
    maxActive: 1,
  },
  hazard: {
    sprites: [
      `${BEETLE_SPRITE_DIR}/beetle_alderLeaf.gif`,
      `${BEETLE_SPRITE_DIR}/beetle_commonSun.gif`,
    ],
    points: 0,
    lifetimeMs: 4000,
    lifetimeDecayPerLevel: 1,
    minLifetimeMs: 4000,
    // Slow base interval so only ~1-2 show up over the course of level 1.
    baseSpawnIntervalMs: 7000,
    spawnIntervalDecayPerLevel: 0.88,
    minSpawnIntervalMs: 2500,
    maxActive: 4,
  },
}

const CATEGORIES = Object.keys(CATEGORY_CONFIG) as FoodCategory[]

/** Every sprite URL used across all categories, for preloading. */
export function getAllSpriteUrls(): string[] {
  return CATEGORIES.flatMap((category) => CATEGORY_CONFIG[category].sprites)
}

/** Exponential decay per level, floored at a minimum. */
function scaleWithLevel(
  base: number,
  decayPerLevel: number,
  level: number,
  min: number,
): number {
  return Math.max(min, base * decayPerLevel ** (level - 1))
}

export const EATEN_PER_LEVEL = 10

export function computeLevel(eatenCount: number): number {
  return Math.floor(eatenCount / EATEN_PER_LEVEL) + 1
}

const MOUTH_HIT_RADIUS_FRACTION = 0.07

export function computeMouthHitRadius(
  canvasWidth: number,
  canvasHeight: number,
): number {
  return MOUTH_HIT_RADIUS_FRACTION * Math.min(canvasWidth, canvasHeight)
}

// Fixed rather than proportional to canvas size, so food/hazard sprites
// (and their hit radius) stay the same visual size across a window
// resize instead of growing/shrinking with the viewport.
const FOOD_RADIUS_PX = 83

/**
 * Spawns food across four categories, each with its own cadence,
 * lifetime, point value and difficulty-per-level curve:
 *  - good: persistent, never expires, spawns faster each level.
 *  - junk: expires on a timer (a temporary temptation, not clutter),
 *    spawns mildly more often each level.
 *  - bonus: rare, short-lived, high value; timer shrinks each level.
 *  - hazard: expires on a timer, spawns notably more often each level —
 *    the main difficulty ramp.
 * Positions are stored as fractions of the canvas size, so they stay
 * correctly placed across a canvas resize with no clamping needed.
 */
export class FoodManager {
  private canvasWidth = 0
  private canvasHeight = 0
  private foods: FoodItem[] = []
  private nextSpawnAt: Record<FoodCategory, number> = {
    good: 0,
    junk: 0,
    bonus: 0,
    hazard: 0,
  }
  private nextId = 1
  private hasStarted = false
  /** Fraction-of-canvas-width [min, max] this instance spawns within —
   * lets split-screen mode give each player their own half. */
  private xRange: [number, number]

  constructor(options: { xRange?: [number, number] } = {}) {
    this.xRange = options.xRange ?? [0, 1]
  }

  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width
    this.canvasHeight = height
  }

  private get radius(): number {
    return FOOD_RADIUS_PX
  }

  private spawn(category: FoodCategory, nowMs: number, level: number): void {
    const config = CATEGORY_CONFIG[category]
    const marginPx = this.radius * 1.5
    const [xMin, xMax] = this.xRange
    const rangeWidth = xMax - xMin
    const marginXFrac = Math.min(
      rangeWidth * 0.45,
      marginPx / this.canvasWidth,
    )
    const marginYFrac = Math.min(0.45, marginPx / this.canvasHeight)
    const xFrac =
      xMin + marginXFrac + Math.random() * (rangeWidth - 2 * marginXFrac)
    const yFrac = marginYFrac + Math.random() * (1 - 2 * marginYFrac)
    const sprite =
      config.sprites[Math.floor(Math.random() * config.sprites.length)]
    const expiresAt =
      config.lifetimeMs === null
        ? null
        : nowMs +
          scaleWithLevel(
            config.lifetimeMs,
            config.lifetimeDecayPerLevel,
            level,
            config.minLifetimeMs,
          )

    this.foods.push({
      id: this.nextId++,
      category,
      xFrac,
      yFrac,
      spawnedAt: nowMs,
      expiresAt,
      sprite,
      points: config.points,
    })
  }

  /** Advance spawn timing and expire timed-out items. Call once per frame. */
  update(nowMs: number, level: number): void {
    if (this.canvasWidth === 0 || this.canvasHeight === 0) return

    // Start blank: the first spawn of each category waits out its own
    // normal interval from the moment the game starts, rather than
    // appearing instantly.
    if (!this.hasStarted) {
      this.hasStarted = true
      for (const category of CATEGORIES) {
        const config = CATEGORY_CONFIG[category]
        this.nextSpawnAt[category] =
          nowMs +
          scaleWithLevel(
            config.baseSpawnIntervalMs,
            config.spawnIntervalDecayPerLevel,
            level,
            config.minSpawnIntervalMs,
          )
      }
    }

    for (let i = this.foods.length - 1; i >= 0; i -= 1) {
      const food = this.foods[i]
      if (food.expiresAt !== null && nowMs >= food.expiresAt) {
        this.foods.splice(i, 1)
      }
    }

    for (const category of CATEGORIES) {
      const config = CATEGORY_CONFIG[category]
      const activeCount = this.foods.reduce(
        (n, f) => n + (f.category === category ? 1 : 0),
        0,
      )
      if (
        nowMs >= this.nextSpawnAt[category] &&
        activeCount < config.maxActive
      ) {
        this.spawn(category, nowMs, level)
        const interval = scaleWithLevel(
          config.baseSpawnIntervalMs,
          config.spawnIntervalDecayPerLevel,
          level,
          config.minSpawnIntervalMs,
        )
        this.nextSpawnAt[category] = nowMs + interval
      }
    }
  }

  /**
   * Call when a chomp event fires this frame with the mouth's pixel
   * position. Removes and returns the closest overlapping item (of any
   * category — food and hazards share the same bite interaction), or
   * null if nothing was in range.
   */
  tryEat(mouthX: number, mouthY: number, mouthRadius: number): FoodItem | null {
    const radius = this.radius
    let closestIndex = -1
    let closestDist = Infinity
    for (let i = 0; i < this.foods.length; i += 1) {
      const food = this.foods[i]
      const x = food.xFrac * this.canvasWidth
      const y = food.yFrac * this.canvasHeight
      const dx = mouthX - x
      const dy = mouthY - y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= mouthRadius + radius && dist < closestDist) {
        closestDist = dist
        closestIndex = i
      }
    }
    if (closestIndex === -1) return null
    const [eaten] = this.foods.splice(closestIndex, 1)
    return eaten
  }

  /**
   * Removes and returns the item with the given id, if still active.
   * Lets a caller find the closest item across *multiple* FoodManagers
   * (e.g. split-screen's two zone pools) before committing to removing
   * it from whichever one actually owns it.
   */
  removeById(id: number): FoodItem | null {
    const index = this.foods.findIndex((food) => food.id === id)
    if (index === -1) return null
    const [removed] = this.foods.splice(index, 1)
    return removed
  }

  /** Removes all food and resets spawn timing, for starting a new game. */
  reset(): void {
    this.foods = []
    this.nextSpawnAt = { good: 0, junk: 0, bonus: 0, hazard: 0 }
    this.hasStarted = false
  }

  /** Current food resolved to pixel positions for the current canvas size. */
  getActiveFoods(): ResolvedFood[] {
    const radius = this.radius
    return this.foods.map((food) => ({
      ...food,
      x: food.xFrac * this.canvasWidth,
      y: food.yFrac * this.canvasHeight,
      radius,
    }))
  }
}
