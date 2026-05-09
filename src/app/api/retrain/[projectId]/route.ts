import { type NextRequest } from 'next/server';
import { EdgeImpulseClient } from '@/lib/edge-impulse';

/**
 * POST /api/retrain/:projectId
 * Header: x-api-key
 * Triggers a retrain on the current impulse with the latest data.
 * Returns the new jobId.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return Response.json({ error: 'x-api-key required' }, { status: 401 });
  const id = Number(projectId);
  if (!id) return Response.json({ error: 'invalid projectId' }, { status: 400 });

  const ei = new EdgeImpulseClient(apiKey, id);
  const start = await ei.startTrain();
  return Response.json({ jobId: start.id });
}

/**
 * GET /api/retrain/:projectId?jobId=N
 * Header: x-api-key
 * Returns current job status plus a tail of stdout once finished.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return Response.json({ error: 'x-api-key required' }, { status: 401 });
  const id = Number(projectId);
  if (!id) return Response.json({ error: 'invalid projectId' }, { status: 400 });
  const jobId = Number(request.nextUrl.searchParams.get('jobId'));
  if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 });

  const ei = new EdgeImpulseClient(apiKey, id);
  const status = await ei.getJobStatus(jobId);
  let stdoutTail: string | undefined;
  if (status.job.finished) {
    try {
      const full = await ei.getJobStdout(jobId);
      stdoutTail = full.split('\n').slice(-30).join('\n');
    } catch {
      // ignore — stdout is best-effort for the VR HUD
    }
  }
  return Response.json({ ...status, stdoutTail });
}
