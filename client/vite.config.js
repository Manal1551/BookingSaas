import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sharedValidation = fileURLToPath(
  new URL('../server/src/validation', import.meta.url)
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rootDomain = env.VITE_ROOT_DOMAIN || 'app.local';
  const appPort = Number(env.VITE_APP_PORT || 5173);

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // The booking Zod schemas are the SAME file the server validates with,
        // imported here as `@shared/booking.schemas.js` so client-side form
        // validation can never drift from the API contract. That module is
        // deliberately dependency-free apart from zod, so it bundles cleanly.
        '@shared': sharedValidation,
      },
    },
    server: {
      host: true, // listen on 0.0.0.0 so *.app.local resolves in the browser
      port: appPort,
      strictPort: true,
      // Allow the root domain and any subdomain of it (e.g. acme.app.local).
      allowedHosts: [rootDomain, `.${rootDomain}`],
      // The shared schemas live outside client/, so Vite must be allowed to
      // serve them in dev.
      fs: { allow: [repoRoot] },
    },
  };
});
