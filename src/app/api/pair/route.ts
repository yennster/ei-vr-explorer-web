import { type NextRequest } from 'next/server';
import { redis, PAIR_KEY, PAIR_TTL_SECONDS, makePairingCode, type PairingPayload } from '@/lib/redis';
import { listProjectsForKey } from '@/lib/edge-impulse';

/**
 * POST /api/pair
 * Body: { apiKey: string }
 * Validates the key by listing the projects it grants access to. Edge Impulse
 * project-scoped API keys (the common case) return exactly one project, so we
 * derive the project ID server-side instead of asking the user. Account-level
 * JWT or multi-project keys return all accessible projects — for now we take
 * the first one (a future iteration could ask the user to disambiguate).
 */
export async function POST(request: NextRequest) {
  let body: { apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { apiKey } = body;
  if (!apiKey || typeof apiKey !== 'string') {
    return Response.json({ error: 'apiKey required' }, { status: 400 });
  }

  let projects: Array<{ id: number; name: string }>;
  try {
    projects = await listProjectsForKey(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid API key';
    console.error('[pair] listProjectsForKey failed:', message);
    return Response.json(
      { error: `Edge Impulse rejected the key: ${message}` },
      { status: 401 },
    );
  }
  if (projects.length === 0) {
    return Response.json({ error: 'API key has no project access' }, { status: 401 });
  }

  const project = projects[0];
  const code = makePairingCode();
  const payload: PairingPayload = { apiKey, projectId: project.id };
  await redis.set(PAIR_KEY(code), JSON.stringify(payload), { ex: PAIR_TTL_SECONDS });

  return Response.json({
    code,
    projectId: project.id,
    projectName: project.name,
    expiresAt: Date.now() + PAIR_TTL_SECONDS * 1000,
  });
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
