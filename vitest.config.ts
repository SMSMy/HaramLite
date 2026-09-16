import { defineConfig } from 'vitest/config';

// Frontend regression tests (board 0.2.7: د-٩ · ج-١٠). Kept in its own config —
// `vite.config.ts` stays the dev/build config for `tauri dev`.
export default defineConfig({
  test: {
    // The units under test are DOM sinks and DOM-reading helpers, so jsdom is
    // required; the path helpers would run in node but share this one config.
    environment: 'jsdom',
    // Explicit include: the repo has other JS trees (browser-extension, scripts)
    // and a bare default glob would collect whatever lands there.
    include: ['src/__tests__/**/*.test.ts'],
  },
});
