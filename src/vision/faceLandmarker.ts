import {
  FaceLandmarker,
  FilesetResolver,
} from '@mediapipe/tasks-vision'

// Pinned to the installed @mediapipe/tasks-vision version so the WASM
// runtime always matches the JS API we're calling against.
const TASKS_VISION_VERSION = '1.0.1'
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

let landmarkerPromise: Promise<FaceLandmarker> | null = null

/**
 * Lazily creates (and caches) a single FaceLandmarker instance running in
 * VIDEO mode, so repeated calls (e.g. React StrictMode double-invoke) reuse
 * the same loaded model instead of re-downloading/re-initializing it.
 */
export function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE_URL).then(
      (filesetResolver) =>
        FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          // 2 for co-op: tracks up to two players' faces from one camera.
          numFaces: 2,
          // Blendshapes give us a head-pose-normalized "jawOpen" score,
          // which holds up under head rotation and off-center framing far
          // better than a raw landmark-distance ratio.
          outputFaceBlendshapes: true,
        }),
    )
  }
  return landmarkerPromise
}
