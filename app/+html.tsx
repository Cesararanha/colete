import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { pt } from '@/lib/i18n/pt';
import { colors } from '@/theme/colors';

const serviceWorkerRegistration = `
(() => {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const notify = () => window.dispatchEvent(new Event('colete:pwa-update'));
      let refreshRequested = false;
      const bridge = {
        activateUpdate: () => {
          if (!registration.waiting) return false;
          refreshRequested = true;
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          return true;
        },
        hasWaitingWorker: () => Boolean(registration.waiting),
      };

      window.__COLETE_PWA__ = bridge;
      if (registration.waiting) notify();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) notify();
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshRequested) window.location.reload();
      });
      window.setInterval(() => registration.update(), 60 * 60 * 1000);
    } catch {
      // The PWA remains usable online when service-worker registration is unavailable.
    }
  });
})();
`;

// Runs before the app and any observability code. The invitation is held only
// in page memory until the join screen consumes it; it never enters a URL
// after this script or any persistent browser store.
const consumeInviteFragment = `
(() => {
  const capture = () => {
    if (location.pathname !== '/join' || !location.hash) return;
    const fragment = location.hash;
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!fragment.startsWith('#token=')) return;
    try { window.__COLETE_INVITE_TOKEN__ = decodeURIComponent(fragment.slice(7)); }
    catch { window.__COLETE_INVITE_TOKEN__ = ''; }
    window.dispatchEvent(new Event('colete:invite-fragment'));
  };
  capture();
  window.addEventListener('hashchange', capture);
})();
`;

const { dark } = colors;

// docs/29 §2/§4: 2 px focus ring with 2 px offset. Human decision of 14/10/2026:
// the app is dark only, so the document is dark from the first paint, whatever
// the system preference. Barlow ships one file per weight, so the browser must
// never synthesize bold or italic on top. Phantom scroll (docs/29 §0): each
// shell scrolls inside its own ScrollView, so the document itself is exactly
// one viewport tall and never scrolls, bounces or pulls to refresh.
const globalStyles = `
  :root { color-scheme: dark; background-color: ${dark.background}; }
  html, body, #root { height: 100%; margin: 0; overscroll-behavior: none; }
  *, *::before, *::after { box-sizing: border-box; }
  body { font-synthesis: none; }
  ::selection { background-color: ${dark.text}; color: ${dark.background}; }
  :focus-visible { outline: 2px solid ${dark.focus}; outline-offset: 2px; }
  [data-band] :focus-visible { outline-color: ${dark.focusOnBand}; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

export default function RootHtml({ children }: PropsWithChildren) {
  return (
    <html data-theme="dark" lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta content="IE=edge" httpEquiv="X-UA-Compatible" />
        <meta
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
          name="viewport"
        />
        <meta content="no-referrer" name="referrer" />
        <meta content={colors.dark.background} name="theme-color" />
        <meta content="yes" name="mobile-web-app-capable" />
        <meta content="yes" name="apple-mobile-web-app-capable" />
        <meta content={pt.app.name} name="apple-mobile-web-app-title" />
        <link href="/manifest.webmanifest" rel="manifest" />
        <link href="/icons/icon-192.png" rel="icon" sizes="192x192" type="image/png" />
        <link href="/icons/icon-192.png" rel="apple-touch-icon" />
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <script dangerouslySetInnerHTML={{ __html: consumeInviteFragment }} />
        <script dangerouslySetInnerHTML={{ __html: serviceWorkerRegistration }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
