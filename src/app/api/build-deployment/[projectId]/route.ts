import { type NextRequest } from 'next/server';
import { EdgeImpulseClient } from '@/lib/edge-impulse';
import { pickPreferredTarget } from '@/lib/pick-target';

/**
 * POST /api/build-deployment/:projectId
 * Header: x-api-key
 *
 * Picks the right deployment target via pickPreferredTarget (Sentis custom
 * block first, then history fallback, then TFLite-bearing standard targets)
 * and ensures a build exists. The actual TFLite → ONNX conversion happens
 * later in /api/model-bundle when the headset asks for the model bytes.
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

  let targets;
  try {
    targets = (await ei.listDeploymentTargets()).targets;
  } catch (err) {
    return Response.json(
      { error: `Failed to list deployment targets: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  const picked = await pickPreferredTarget(ei, targets);
  if (picked.kind === 'no-target') {
    return Response.json(
      {
        error:
          'No deployment target found. Available formats: ' +
          (picked.availableFormats.join(', ') || '(none)'),
      },
      { status: 422 },
    );
  }
  const target = picked.target;

  // 1. Already built?
  let existing;
  try {
    existing = await ei.getDeployment(target.format, target.engine);
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
      type: target.format,
      engine: target.engine,
      isSentisBlock: target.isSentis,
      targetName: target.name,
      fromHistory: target.fromHistory,
    });
  }

  // 2. Trigger build.
  const startedAt = Date.now();
  let jobId: number;
  try {
    const start = await ei.buildOnDeviceModel(target.format, target.engine);
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
      type: target.format,
      engine: target.engine,
      isSentisBlock: target.isSentis,
      targetName: target.name,
      fromHistory: target.fromHistory,
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
 * Existence check — does NOT trigger a build.
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
    const targets = (await ei.listDeploymentTargets()).targets;
    const picked = await pickPreferredTarget(ei, targets);
    if (picked.kind === 'no-target') {
      return Response.json({
        hasDeployment: false,
        targetFound: false,
        availableFormats: picked.availableFormats,
      });
    }
    const t = picked.target;
    const r = await ei.getDeployment(t.format, t.engine);
    return Response.json({
      hasDeployment: r.hasDeployment,
      targetFound: true,
      version: r.version,
      type: t.format,
      engine: t.engine,
      isSentisBlock: t.isSentis,
      targetName: t.name,
      fromHistory: t.fromHistory,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[build-deployment] GET status check failed for project ${id}:`, message);
    return Response.json({ error: message }, { status: 502 });
  }
}
