import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';

async function start() {
  await connectDb();
  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`🚀 API listening on http://localhost:${env.PORT}`);
    console.log(`   Root domain: ${env.ROOT_DOMAIN}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
