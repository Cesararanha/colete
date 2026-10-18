import { expect, type Page } from './csp';
import { inviteQrMatrix } from '../../src/features/groups/invite-qr';

// The simulated camera of the QR suite, shared with the invitation page suite.
export type CameraProbe = {
  mode: string;
  tracks: MediaStreamTrack[];
  stops: number;
  requests: number;
  frameReads: number;
  frameSizes: number[];
  release: (() => void) | null;
};
declare global {
  interface Window {
    __qrCameraProbe: CameraProbe;
  }
}

/** Camera API/video transport only are replaced: actual canvas pixels enter the production jsQR decoder.
 * captureStream intentionally does not depend on the production Permissions-Policy;
 * device validation with camera=(self) belongs to the human post-merge gate.
 */
export async function simulateCamera(page: Page, value: string, mode = 'qr') {
  const matrix = inviteQrMatrix(value);
  await page.addInitScript(
    ({ matrix, mode }) => {
      const state: CameraProbe = {
        mode,
        tracks: [],
        stops: 0,
        requests: 0,
        frameReads: 0,
        frameSizes: [],
        release: null,
      };
      window.__qrCameraProbe = state;
      // Simulate the entire camera transport, not the decoder. Linux WebKit's
      // media backend cannot reliably play canvas MediaStreams like macOS does.
      // Actual canvas pixels still enter production drawImage/getImageData/jsQR;
      // actual MediaStream tracks still prove stop/readyState, including clones.
      const sources = new WeakMap<MediaStream, HTMLCanvasElement>();
      const attached = new WeakMap<
        HTMLMediaElement,
        { stream: MediaStream; canvas: HTMLCanvasElement }
      >();
      const sourceProperty = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'srcObject',
      )!;
      const readyProperty = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'readyState',
      )!;
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        get() {
          return attached.get(this)?.stream ?? sourceProperty.get!.call(this);
        },
        set(stream: MediaStream | null) {
          const canvas = stream === null ? undefined : sources.get(stream);
          if (stream && canvas) {
            attached.set(this, { stream, canvas });
            if (this instanceof HTMLVideoElement) this.poster = canvas.toDataURL();
          } else {
            attached.delete(this);
            this.removeAttribute('poster');
            sourceProperty.set!.call(this, stream);
          }
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        configurable: true,
        get() {
          return attached.has(this) ? 4 : readyProperty.get!.call(this);
        },
      });
      for (const [name, side] of [
        ['videoWidth', 'width'],
        ['videoHeight', 'height'],
      ] as const) {
        const original = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name)!;
        Object.defineProperty(HTMLVideoElement.prototype, name, {
          configurable: true,
          get() {
            return attached.get(this)?.canvas[side] ?? original.get!.call(this);
          },
        });
      }
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return attached.has(this) ? Promise.resolve() : originalPlay.call(this);
      };
      const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (
        image: CanvasImageSource,
        ...coordinates: number[]
      ) {
        const source = image instanceof HTMLVideoElement ? attached.get(image)?.canvas : undefined;
        return Reflect.apply(originalDraw, this, [source ?? image, ...coordinates]);
      };
      const originalPixels = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (
        ...args: Parameters<typeof originalPixels>
      ) {
        state.frameReads += 1;
        state.frameSizes.push(Math.max(this.canvas.width, this.canvas.height));
        if (state.mode === 'decode-error') throw new Error('Synthetic camera failure');
        return originalPixels.apply(this, args);
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async (constraints: MediaStreamConstraints) => {
            state.requests += 1;
            if (constraints.audio !== false) throw new Error('Unexpected audio request');
            if (state.mode === 'denied') throw new DOMException('', 'NotAllowedError');
            if (state.mode === 'missing') throw new DOMException('', 'NotFoundError');
            const canvas = document.createElement('canvas');
            canvas.width = 960;
            canvas.height = 720;
            const context = canvas.getContext('2d')!;
            const draw = () => {
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              if (state.mode === 'qr') {
                const scale = Math.floor(640 / (matrix.length + 8));
                context.fillStyle = '#000000';
                matrix.forEach((row, y) =>
                  row.forEach((dark, x) => {
                    if (dark)
                      context.fillRect(120 + (x + 4) * scale, 40 + (y + 4) * scale, scale, scale);
                  }),
                );
              }
            };
            draw();
            const stream = canvas.captureStream(10);
            stream.addTrack(stream.getVideoTracks()[0]!.clone());
            sources.set(stream, canvas);
            const tick = setInterval(draw, 100);
            stream.getTracks().forEach((track) => {
              const stop = track.stop.bind(track);
              track.stop = () => {
                state.stops += 1;
                clearInterval(tick);
                stop();
              };
              state.tracks.push(track);
            });
            if (state.mode === 'late')
              await new Promise<void>((resolve) => {
                state.release = resolve;
              });
            return stream;
          },
        },
      });
    },
    { matrix, mode },
  );
}
export async function stopped(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = window.__qrCameraProbe;
        return (
          probe.tracks.length > 0 &&
          probe.tracks.every((track) => track.readyState === 'ended') &&
          probe.stops >= probe.tracks.length
        );
      }),
    )
    .toBe(true);
  const reads = await page.evaluate(() => window.__qrCameraProbe.frameReads);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__qrCameraProbe.frameReads)).toBe(reads);
}
