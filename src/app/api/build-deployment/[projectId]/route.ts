import { type NextRequest } from 'next/server';
import { EdgeImpulseClient, type DeployType, type ModelEngine } from '@/lib/edge-impulse';

const TARGET_TYPE: DeployType = 'onnx';
const TARGET_ENGINE: ModelEngine = 'tflite-eon';

/**
 * POST /api/build-deployment/:projectId
 * Header: x-api-key
 *
 * Ensures the project has an ONNX deployment built with EON Compiler enabled
 * (the format Unity Sentis expects, with DSP baked into the ONNX so we feed
 * raw IMU/audio samples directly).
 *
 * Flow:
 *   1. Check getDeployment(onnx, tflite-eon) — if hasDeployment, done.
 *   2. Otherwise POST jobs/build-ondevice-model → jobId.
 *   3. Long-poll job status until finished. Vercel function timeout is 300s.
 *   4. Return { built: true|false, alreadyExisted, jobId, durationMs }.
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

  // 1. Already built?
  let existing;
  try {
    existing = await ei.getDeployment(TARGET_TYPE, TARGET_ENGINE);
  } catch (err) {
    return Response.json(
      { error: `Failed to check deployment status: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  if (existing.hasDeployment) {
    return Response.json({
      built: true,
      alreadyExisted: true,
      version: existing.version,
      type: TARGET_TYPE,
      engine: TARGET_ENGINE,
    });
  }

  // 2. Trigger build.
  const startedAt = Date.now();
  let jobId: number;
  try {
    const start = await ei.buildOnDeviceModel(TARGET_TYPE, TARGET_ENGINE);
    jobId = start.id;
  } catch (err) {
    return Response.json(
      { error: `Failed to start build: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // 3. Poll until done. Cap at 4.5 minutes to leave headroom under the 300s
  //    Vercel function timeout.
  const deadline = startedAt + 4.5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    let status;
    try {
      status = await ei.getJobStatus(jobId);
    } catch {
      // transient; keep polling
      continue;
    }
    if (!status.job.finished) continue;
    if (!status.job.finishedSuccessful) {
      const stdout = await ei.getJobStdout(jobId).catch(() => '');
      return Response.json(
        {
          error: 'Build job failed',
          jobId,
          stdoutTail: stdout.split('\n').slice(-30).join('\n'),
        },
        { status: 502 },
      );
    }
    return Response.json({
      built: true,
      alreadyExisted: false,
      jobId,
      durationMs: Date.now() - startedAt,
      type: TARGET_TYPE,
      engine: TARGET_ENGINE,
    });
  }

  return Response.json(
    { error: 'Build did not complete within the function timeout', jobId },
    { status: 504 },
  );
}

/**
 * GET /api/build-deployment/:projectId
 * Header: x-api-key
 * Lightweight existence check — does NOT trigger a build. Useful to decide
 * whether to show the build button on the page.
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
  const ei = new EdgeImpulseClient(apiKey, id);
  try {
    const r = await ei.getDeployment(TARGET_TYPE, TARGET_ENGINE);
    return Response.json({
      hasDeployment: r.hasDeployment,
      version: r.version,
      type: TARGET_TYPE,
      engine: TARGET_ENGINE,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Status check failed' },
      { status: 502 },
    );
  }
}
