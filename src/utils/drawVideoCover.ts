export interface CoverCropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * The source rectangle (in video pixel coordinates) that
 * `object-fit: cover` would show for a target canvas of the given size —
 * cropping the video's edges to preserve aspect ratio, never stretching.
 */
export function computeCoverCropRect(
  video: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
): CoverCropRect {
  const videoAspect = video.videoWidth / video.videoHeight
  const canvasAspect = canvasWidth / canvasHeight

  let sx = 0
  let sy = 0
  let sw = video.videoWidth
  let sh = video.videoHeight

  if (videoAspect > canvasAspect) {
    sw = video.videoHeight * canvasAspect
    sx = (video.videoWidth - sw) / 2
  } else {
    sh = video.videoWidth / canvasAspect
    sy = (video.videoHeight - sh) / 2
  }

  return { sx, sy, sw, sh }
}

/**
 * Draws `video` to fill [0, 0, canvasWidth, canvasHeight] using a
 * precomputed cover-crop rect. Doing the crop here, rather than scaling
 * the canvas element via CSS, means canvas pixel coordinates always
 * match what's actually visible on screen, so anything positioned
 * within canvas bounds (e.g. spawned food) is guaranteed to be on
 * screen regardless of window size/aspect ratio.
 */
export function drawVideoCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
  cropRect: CoverCropRect,
): void {
  const { sx, sy, sw, sh } = cropRect
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvasWidth, canvasHeight)
}

/**
 * Face Landmarker's normalized landmarks are relative to the full,
 * uncropped video frame. Since we crop the video into the canvas (see
 * above), a landmark-derived point needs remapping into the crop's
 * coordinate space first, or it drifts out of alignment with the
 * visible video whenever canvas and video aspect ratios differ.
 */
export function remapNormalizedPoint(
  u: number,
  v: number,
  video: HTMLVideoElement,
  cropRect: CoverCropRect,
): { x: number; y: number } {
  const { sx, sy, sw, sh } = cropRect
  const px = u * video.videoWidth
  const py = v * video.videoHeight
  return { x: (px - sx) / sw, y: (py - sy) / sh }
}
