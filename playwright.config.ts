import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Zvonilka E2E tests.
 * - Runs Chromium with fake media devices so WebRTC can auto-grant mic.
 * - Uses Vite preview on http://localhost:4173 by default.
 * - Stores trace/video on failures for debugging in CI and locally.
 */
export default defineConfig({
  testDir: './e2e',
  /* Global timeouts */
  timeout: 30_000,
  expect: { timeout: 5_000 },

  /* Default context options */
  use: {
    // If PW_BASE_URL is provided, it overrides the default preview URL.
    baseURL: process.env.PW_BASE_URL || 'http://localhost:4173',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      // Fake media so tests do not prompt for mic permissions.
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },

  /* Single-browser matrix for now; can expand later */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  /* Simple reporter; CI can switch to 'github' if desired */
  reporter: [['list']],
});
