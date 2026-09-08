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

const globalStyles = `
  :root { color-scheme: light dark; }
  html, body, #root {
    background-color: ${colors.light.background};
    min-height: 100%;
    margin: 0;
  }
  *, *::before, *::after { box-sizing: border-box; }
  :focus-visible { outline: 3px solid ${colors.light.focus}; outline-offset: 3px; }
  @media (prefers-color-scheme: dark) {
    html, body, #root { background-color: ${colors.dark.background}; }
    :focus-visible { outline-color: ${colors.dark.focus}; }
  }
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
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta content="IE=edge" httpEquiv="X-UA-Compatible" />
        <meta
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
          name="viewport"
        />
        <meta content="no-referrer" name="referrer" />
        <meta content={colors.light.primary} name="theme-color" />
        <meta content="yes" name="mobile-web-app-capable" />
        <meta content="yes" name="apple-mobile-web-app-capable" />
        <meta content={pt.app.name} name="apple-mobile-web-app-title" />
        <link href="/manifest.webmanifest" rel="manifest" />
        <link href="/icons/icon-192.png" rel="icon" sizes="192x192" type="image/png" />
        <link href="/icons/icon-192.png" rel="apple-touch-icon" />
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <script dangerouslySetInnerHTML={{ __html: serviceWorkerRegistration }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
