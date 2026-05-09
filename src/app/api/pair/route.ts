import { type NextRequest } from 'next/server';
import { redis, PAIR_KEY, PAIR_TTL_SECONDS, makePairingCode, type PairingPayload } from '@/lib/redis';
import { EdgeImpulseClient } from '@/lib/edge-impulse';

/**
 * POST /api/pair
 * Body: { apiKey: string, projectId: number }
 * Validates the credentials by calling EI Studio, then stores them under a
 * fresh 6-digit pairing code with 5-minute TTL. Returns { code, expiresAt }.
 */
export async function POST(request: NextRequest) {
  let body: { apiKey?: string; projectId?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { apiKey, projectId } = body;
  if (!apiKey || typeof apiKey !== 'string' || !projectId) {
    return Response.json({ error: 'apiKey and projectId required' }, { status: 400 });
  }

  // Validate by calling EI Studio.
  try {
    await new EdgeImpulseClient(apiKey, projectId).getProject();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid credentials';
    return Response.json({ error: `Edge Impulse rejected the credentials: ${message}` }, { status: 401 });
  }

  const code = makePairingCode();
  const payload: PairingPayload = { apiKey, projectId };
  await redis.set(PAIR_KEY(code), JSON.stringify(payload), { ex: PAIR_TTL_SECONDS });

  return Response.json({ code, expiresAt: Date.now() + PAIR_TTL_SECONDS * 1000 });
}

/**
 * GET /api/pair?code=123456
 * Headset polls with the code. Returns the credentials once and deletes
 * the record (one-time use).
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) return Response.json({ error: 'code required' }, { status: 400 });

  const raw = await redis.get<string>(PAIR_KEY(code));
  if (!raw) return Response.json({ error: 'unknown or expired code' }, { status: 404 });

  await redis.del(PAIR_KEY(code));
  // Upstash auto-deserializes JSON strings. Handle both.
  const payload: PairingPayload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Response.json(payload);
}
