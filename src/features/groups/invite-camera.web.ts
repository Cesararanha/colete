export type CameraFailure = 'denied' | 'unavailable';
type Decoder = (typeof import('jsqr'))['default'];
type Callbacks = {
  onRead: (value: string) => void;
  onError: (reason: CameraFailure) => void;
  onReady: () => void;
  onInactive: () => void;
};

export const SCAN_INTERVAL_MS = 125;
export const SCAN_MAX_SIDE = 480;

/** Owns every stream, including permission promises that resolve after cancellation. */
export function startInviteCamera(video: HTMLVideoElement, callbacks: Callbacks) {
  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => {
      track.removeEventListener('ended', videoError);
      track.stop();
    });
    stream = null;
    video.pause();
    video.srcObject = null;
    window.removeEventListener('pagehide', inactive);
    document.removeEventListener('visibilitychange', visibility);
    video.removeEventListener('error', videoError);
  };
  const fail = (reason: CameraFailure) => {
    if (stopped) return;
    stop();
    callbacks.onError(reason);
  };
  const inactive = () => {
    if (stopped) return;
    stop();
    callbacks.onInactive();
  };
  const visibility = () => {
    if (document.hidden) inactive();
  };
  const videoError = () => fail('unavailable');
  window.addEventListener('pagehide', inactive);
  document.addEventListener('visibilitychange', visibility);
  video.addEventListener('error', videoError);

  const scan = (decode: Decoder) => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && context) {
        const ratio = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
        canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = decode(pixels.data, pixels.width, pixels.height, {
          inversionAttempts: 'dontInvert',
        });
        if (result) {
          stop();
          callbacks.onRead(result.data);
          return;
        }
      }
      timer = setTimeout(() => scan(decode), SCAN_INTERVAL_MS);
    } catch {
      fail('unavailable');
    }
  };
  void (async () => {
    try {
      if (!context || !navigator.mediaDevices?.getUserMedia) {
        fail('unavailable');
        return;
      }
      // Metro web emits a separate decoder chunk. No Expo/WASM scanner enters web.
      const { default: decode } = await import('jsqr');
      if (stopped) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        return;
      }
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', videoError));
      video.srcObject = stream;
      await video.play();
      if (stopped) return;
      callbacks.onReady();
      scan(decode);
    } catch (error) {
      const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
  })();
  return { stop };
}
