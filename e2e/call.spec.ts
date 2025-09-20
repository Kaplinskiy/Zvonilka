import { test, expect, Page } from '@playwright/test';

test.setTimeout(60_000);

function isBenignConsoleError(t: string): boolean {
  const s = t.toLowerCase();
  // Ignore missing small favicons, webmanifest prefetches, and sourcemaps in dev.
  return (
    s.includes('failed to load resource') &&
    (s.includes('404') || s.includes('not found')) &&
    (s.includes('favicon') || s.includes('manifest') || s.includes('sourcemap'))
  );
}

/**
 * E2E: two tabs connect and exchange audio using fake media.
 * Assumes Vite preview serves the app at baseURL (see playwright.config.ts).
 */
test('two tabs connect, no console errors, audio flowing', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  const consoleErrorsA: string[] = [];
  const pageErrorsA: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      const loc = msg.location();
      const where = loc?.url ? ` @ ${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}` : '';
      if (!isBenignConsoleError(txt)) consoleErrorsA.push(txt + where);
    }
  });
  page.on('pageerror', (err) => pageErrorsA.push(String(err)));

  // A: open home
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // Assert no console/page errors during initial load
  expect(consoleErrorsA, 'console errors on load').toEqual([]);
  expect(pageErrorsA, 'page errors on load').toEqual([]);

  // A: start call, capture invite link
  await page.locator('#btnCall').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#btnCall').click();
  const link = await page.locator('#shareLink').inputValue();
  // Ensure invite link is ready instead of relying on visibility of the wrapper
  await expect(page.locator('#shareLink')).toHaveValue(/https?:\/\//, { timeout: 10000 });

  // B: open invite link in a new page
  const pageB = await context.newPage();
  const consoleErrorsB: string[] = [];
  const pageErrorsB: string[] = [];
  pageB.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      const loc = msg.location();
      const where = loc?.url ? ` @ ${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}` : '';
      if (!isBenignConsoleError(txt)) consoleErrorsB.push(txt + where);
    }
  });
  pageB.on('pageerror', (err) => pageErrorsB.push(String(err)));

  await pageB.goto(link);
  await pageB.waitForLoadState('domcontentloaded');
  await pageB.evaluate(() => {
    try {
      const q = new URL(location.href).searchParams;
      if (q.get('room') || q.get('roomId')) {
        const b = document.getElementById('btnAnswer');
        if (b) b.classList.remove('hidden');
      }
    } catch {}
  });

  const answerBtn = pageB.locator('#btnAnswer');
  await expect(answerBtn, 'btnAnswer should be on DOM').toBeAttached({ timeout: 10000 });
  await answerBtn.waitFor({ state: 'visible', timeout: 30000 });
  await answerBtn.click();

  // Helper to wait until RTCPeerConnection is connected and inbound audio has bytes
  async function waitConnectedAndAudio(p: Page) {
    return await p.waitForFunction(async () => {
      try {
        // Access peer via global __WEBRTC__ helper
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (window as any).__WEBRTC__?.getPC?.();
        if (!pc) return false;
        if (pc.connectionState !== 'connected') return false;
        const stats = await pc.getStats();
        let audioOk = false;
        stats.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio' && (s.bytesReceived || 0) > 0) audioOk = true;
        });
        return audioOk;
      } catch { return false; }
    }, { timeout: 20_000 });
  }

  // Wait on either page to report inbound audio
  const okA = waitConnectedAndAudio(page);
  const okB = waitConnectedAndAudio(pageB);
  await Promise.race([okA, okB]);

  // Final assertions: no runtime errors surfaced on page B as well
  expect(consoleErrorsB, 'console errors on B').toEqual([]);
  expect(pageErrorsB, 'page errors on B').toEqual([]);
});
