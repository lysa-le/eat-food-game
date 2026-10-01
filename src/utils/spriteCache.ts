const cache = new Map<string, HTMLImageElement>()

/**
 * Lazily creates (and caches) an HTMLImageElement for a sprite URL. The
 * image starts loading immediately; canvas drawImage calls made before
 * it's ready are simply no-ops (the browser skips drawing an incomplete
 * image), so callers don't need to await anything — the sprite just
 * "pops in" once loaded, which for small local PNGs is effectively
 * instant.
 */
export function getSprite(url: string): HTMLImageElement {
  let img = cache.get(url)
  if (!img) {
    img = new Image()
    img.src = url
    cache.set(url, img)
  }
  return img
}

/** Preload a set of sprite URLs immediately (e.g. at module load). */
export function preloadSprites(urls: string[]): void {
  for (const url of urls) {
    getSprite(url)
  }
}
