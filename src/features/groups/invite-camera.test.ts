import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startInviteCamera, SCAN_MAX_SIDE } from './invite-camera.web';

const decode = vi.hoisted(() => vi.fn());
vi.mock('jsqr', () => ({ default: decode }));

function probe() {
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = Object.assign(new EventTarget(), {
    srcObject: null,
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  });
  const canvas = { width: 0, height: 0, getContext: () => context };
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: canvas.width,
      height: canvas.height,
    })),
  };
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => canvas });
  const win = new EventTarget();
  const media = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } });
  const callbacks = { onRead: vi.fn(), onError: vi.fn(), onReady: vi.fn(), onInactive: vi.fn() };
  return {
    track,
    stream,
    video,
    canvas,
    context,
    doc,
    win,
    media,
    callbacks,
    start: () => startInviteCamera(video as unknown as HTMLVideoElement, callbacks),
  };
}
let close: (() => void) | undefined;
beforeEach(() => {
  decode.mockReset();
  decode.mockReturnValue(null);
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllGlobals();
});

describe('camera ownership', () => {
  it('uses video only, reduced frames, and stops before delivering the decoded value', async () => {
    const p = probe();
    decode.mockReturnValue({ data: 'synthetic-invite' });
    p.callbacks.onRead.mockImplementation(() => {
      expect(p.track.readyState).toBe('ended');
    });
    close = p.start().stop;
    await vi.waitFor(() => expect(p.callbacks.onRead).toHaveBeenCalledTimes(1));
    expect(p.media.mock.calls[0]?.[0]).toMatchObject({ audio: false });
    expect(Math.max(p.canvas.width, p.canvas.height)).toBe(SCAN_MAX_SIDE);
    expect(p.video.srcObject).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(decode).toHaveBeenCalledTimes(1);
  });
  it('stops a stream returned after cancellation without playing or decoding it', async () => {
    const p = probe();
    let release!: (stream: typeof p.stream) => void;
    p.media.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    close = p.start().stop;
    await vi.waitFor(() => expect(p.media).toHaveBeenCalledOnce());
    close();
    release(p.stream);
    await vi.waitFor(() => expect(p.track.readyState).toBe('ended'));
    expect(p.video.play).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });
  it('ignores blur during permission and after ready, then reads normally', async () => {
    const p = probe();
    let release!: (stream: typeof p.stream) => void;
    p.media.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    close = p.start().stop;
    await vi.waitFor(() => expect(p.media).toHaveBeenCalledOnce());
    p.win.dispatchEvent(new Event('blur'));
    expect(p.callbacks.onInactive).not.toHaveBeenCalled();
    release(p.stream);
    await vi.waitFor(() => expect(p.callbacks.onReady).toHaveBeenCalledOnce());
    p.win.dispatchEvent(new Event('blur'));
    expect(p.track.readyState).toBe('live');
    expect(p.callbacks.onInactive).not.toHaveBeenCalled();
    decode.mockReturnValue({ data: 'synthetic-invite' });
    await vi.waitFor(() => expect(p.callbacks.onRead).toHaveBeenCalledOnce());
    expect(p.track.readyState).toBe('ended');
  });
  it('does not request camera permission if cancelled while loading the decoder', async () => {
    const p = probe();
    close = p.start().stop;
    close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(p.media).not.toHaveBeenCalled();
  });
  it.each(['pagehide', 'hidden', 'error', 'ended'])(
    'stops on %s and releases video ownership',
    async (event) => {
      const p = probe();
      close = p.start().stop;
      await vi.waitFor(() => expect(p.callbacks.onReady).toHaveBeenCalledOnce());
      if (event === 'hidden') {
        p.doc.hidden = true;
        p.doc.dispatchEvent(new Event('visibilitychange'));
      } else if (event === 'error') p.video.dispatchEvent(new Event(event));
      else if (event === 'ended') p.track.dispatchEvent(new Event(event));
      else p.win.dispatchEvent(new Event(event));
      expect(p.track.readyState).toBe('ended');
      expect(p.video.srcObject).toBeNull();
      const count = decode.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(decode.mock.calls.length).toBe(count);
    },
  );
  it('sanitizes permission errors and catches decoder failures with track cleanup', async () => {
    const p = probe();
    p.media.mockRejectedValue(new DOMException('private data', 'NotAllowedError'));
    close = p.start().stop;
    await vi.waitFor(() => expect(p.callbacks.onError).toHaveBeenCalledWith('denied'));
    expect(p.callbacks.onError.mock.calls[0]).toEqual(['denied']);
    close();
    p.media.mockResolvedValue(p.stream);
    decode.mockImplementation(() => {
      throw new Error('private QR content');
    });
    close = p.start().stop;
    await vi.waitFor(() => expect(p.callbacks.onError).toHaveBeenLastCalledWith('unavailable'));
    expect(p.track.readyState).toBe('ended');
  });
});
