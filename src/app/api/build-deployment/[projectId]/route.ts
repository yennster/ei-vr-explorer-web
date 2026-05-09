import { type NextRequest } from 'next/server';
import { EdgeImpulseClient, type ModelEngine, type DeploymentTarget } from '@/lib/edge-impulse';

// Edge Impulse doesn't expose ONNX as a deploy block for most projects, so
// we use the universally-available `arduino` (or fallback) target with the
// plain `tflite` engine — that gives us a TFLite flatbuffer we extract from
// the zip and convert to ONNX server-side. EON Compiler engines aren't
// portable to ONNX so we explicitly avoid them.
const PREFERRED_ENGINE: ModelEngine = 'tflite';
const TARGET_PRIORITY = ['arduino', 'android-cpp', 'wasm-browser-simd', 'wasm', 'zip'];

function pickTFLiteTarget(targets: DeploymentTarget[]): DeploymentTarget | null {
  const enabled = targets.filter((t) => !t.disabledForProject);
  for (const wanted of TARGET_PRIORITY) {
    const hit = enabled.find((t) => (t.format || '').toLowerCase() === wanted);
    if (hit) return hit;
  }
  // Fallback: any enabled target supporting plain tflite engine.
  return enabled.find((t) => t.supportedEngines.includes('tflite')) ?? null;
}

/**
 * POST /api/build-deployment/:projectId
 * Header: x-api-key
 *
 * Discovers a TFLite-bearing deployment target for the project (arduino,
 * android-cpp, wasm, …) and ensures a build exists with the plain `tflite`
 * engine. The actual TFLite → ONNX conversion happens later in
 * /api/model-bundle when the headset asks for the model bytes — keeping
 * this endpoint a fast "build only" call.
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

  // Discover the right deployment type for THIS project.
  let targets;
  try {
    targets = (await ei.listDeploymentTargets()).targets;
  } catch (err) {
    return Response.json(
      { error: `Failed to list deployment targets: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  const target = pickTFLiteTarget(targets);
  if (!target) {
    const formats = targets.map((t) => t.format).filter(Boolean);
    return Response.json(
      {
        error:
          'No TFLite-bearing deployment target found (looked for ' +
          `${TARGET_PRIORITY.join('/')}). Available formats: ${formats.join(', ') || '(none)'}.`,
      },
      { status: 422 },
    );
  }
  const engine: ModelEngine = target.supportedEngines.includes(PREFERRED_ENGINE)
    ? PREFERRED_ENGINE
    : (target.supportedEngines[0] ?? 'tflite');

  // 1. Already built?
  let existing;
  try {
    existing = await ei.getDeployment(target.format, engine);
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
      engine,
    });
  }

  // 2. Trigger build.
  const startedAt = Date.now();
  let jobId: number;
  try {
    const start = await ei.buildOnDeviceModel(target.format, engine);
    jobId = start.id;
  } catch (err) {
    return Response.json(
      { error: `Failed to start build: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // 3. Poll until done. Cap at 4.5 minutes.
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
      engine,
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
    const target = pickTFLiteTarget(targets);
    if (!target) {
      const formats = targets.map((t) => t.format).filter(Boolean);
      return Response.json({
        hasDeployment: false,
        targetFound: false,
        availableFormats: formats,
      });
    }
    const engine: ModelEngine = target.supportedEngines.includes(PREFERRED_ENGINE)
      ? PREFERRED_ENGINE
      : (target.supportedEngines[0] ?? 'tflite');
    const r = await ei.getDeployment(target.format, engine);
    return Response.json({
      hasDeployment: r.hasDeployment,
      targetFound: true,
      version: r.version,
      type: target.format,
      engine,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[build-deployment] GET status check failed for project ${id}:`, message);
    return Response.json({ error: message }, { status: 502 });
  }
}
