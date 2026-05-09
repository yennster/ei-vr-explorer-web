import { Redis } from '@upstash/redis';

export type PairingPayload = {
  apiKey: string;
  projectId: number;
};

export const PAIR_KEY = (code: string) => `pair:${code}`;
export const PAIR_TTL_SECONDS = 5 * 60; // 5 min

export function makePairingCode(): string {
  // 6-digit zero-padded code, easy to type on a Quest virtual keyboard.
  return Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
}

// Minimal in-memory shim with the methods we use, for local dev only.
class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, opts?: { ex?: number }): Promise<'OK'> {
    const ttl = opts?.ex ?? 0;
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : Number.POSITIVE_INFINITY,
    });
    return 'OK';
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as unknown as T;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

/**
 * Upstash Redis is provisioned via the Vercel Marketplace. The Marketplace
 * integration auto-injects KV_REST_API_URL and KV_REST_API_TOKEN env vars.
 * For local dev, fall back to in-memory so the app still runs without Redis.
 */
export const redis: Redis | InMemoryRedis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      })
    : new InMemoryRedis();
