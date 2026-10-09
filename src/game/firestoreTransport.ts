/**
 * Whether Firestore should use long polling instead of its default
 * streaming connection. Safari (and every iOS browser — they all run
 * WebKit) can hold back small streamed updates and deliver them late: in
 * play-testing, an iPhone guest saw the host's Start more than 5 seconds
 * after the host had started playing. Long polling completes a response
 * per update, so nothing sits in a buffer. Firebase recommends forcing it
 * where streaming misbehaves.
 */
export function prefersLongPolling(
  userAgent: string,
  platform = '',
  maxTouchPoints = 0,
): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(userAgent) ||
    // iPadOS reports itself as a Mac.
    (platform === 'MacIntel' && maxTouchPoints > 1)
  const desktopSafari =
    /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Android/.test(userAgent)
  return ios || desktopSafari
}
