import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

/**
 * `mongodb+srv://` URIs require a DNS SRV lookup. On some setups (notably
 * Windows/Node's c-ares picking up an unreachable IPv6 router as its resolver)
 * that lookup fails with `querySrv ECONNREFUSED` even though the OS resolver
 * works fine. Prepend well-known public resolvers so the SRV lookup succeeds,
 * keeping the machine's own servers as fallback. No effect on non-SRV URIs.
 */
function ensureSrvDnsResolvable(uri) {
  if (!uri.startsWith('mongodb+srv://')) return;
  try {
    const existing = dns.getServers();
    dns.setServers([...new Set(['8.8.8.8', '1.1.1.1', ...existing])]);
  } catch {
    // Best effort — if the platform rejects setServers, fall back to defaults.
  }
}

export async function connectDb() {
  mongoose.set('strictQuery', true);
  ensureSrvDnsResolvable(env.MONGODB_URI);
  // Never log the URI — it contains credentials.
  await mongoose.connect(env.MONGODB_URI);
  console.log('✅ MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
