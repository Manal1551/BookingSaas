import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rootDomain = env.VITE_ROOT_DOMAIN || 'app.local';
  const appPort = Number(env.VITE_APP_PORT || 5173);

  return {
    plugins: [react()],
    server: {
      host: true, // listen on 0.0.0.0 so *.app.local resolves in the browser
      port: appPort,
      strictPort: true,
      // Allow the root domain and any subdomain of it (e.g. acme.app.local).
      allowedHosts: [rootDomain, `.${rootDomain}`],
    },
  };
});
