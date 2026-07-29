import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

/**
 * Reuses the app's Vite config so component tests resolve `@shared/...` to the
 * server's Zod schemas exactly like the real build does — the tests therefore
 * exercise the same validation rules the API enforces.
 */
export default defineConfig((configEnv) =>
  mergeConfig(
    viteConfig(configEnv),
    defineConfig({
      test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/test/setup.js'],
        include: ['src/**/*.test.{js,jsx}'],
        restoreMocks: true,
      },
    })
  )
);
