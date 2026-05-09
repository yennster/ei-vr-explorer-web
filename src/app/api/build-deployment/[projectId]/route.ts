import { type NextRequest } from 'next/server';
import { EdgeImpulseClient, type ModelEngine, type DeploymentTarget } from '@/lib/edge-impulse';

// Two paths:
//   - PREFERRED: an installed "Unity Sentis" custom deployment block (matches
//     the ei-unity-sentis-block repo). It already produces a Sentis-ready
//     deploy.zip, so the companion just downloads + streams.
//   - FALLBACK: a TFLite-bearing target (`arduino` / `android-cpp` / `wasm`)
//     with the plain `tflite` engine. We then extract + convert to ONNX
//     server-side via /api/convert.
const PREFERRED_ENGINE: ModelEngine = 'tflite';
const TARGET_PRIORITY = ['arduino', 'android-cpp', 'wasm-browser-simd', 'wasm', 'zip'];

/** Match anything that looks like the Unity Sentis custom block. */
function isSentisBlock(t: DeploymentTarget): boolean {
  const f = (t.format || '').toLowerCase();
  const n = (t.name || '').toLowerCase();
  const d = (t.description || '').toLowerCase();
  // Custom-block formats are project-specific slugs from EI; match by name +
  // description to be robust across slug conventions.
  return n.includes('sentis')
      || n.includes('unity sentis')
      || f.includes('sentis')
      || (n.includes('unity') && (n.includes('onnx') || d.includes('onnx + c#')));
}

function pickTFLiteTarget(targets: DeploymentTarget[]): DeploymentTarget | null {
  const enabled = targets.filter((t) => !t.disabledForProject);
  // Prefer the Unity Sentis custom block if present (skips the whole
  // extract-and-convert dance).
  const sentis = enabled.find(isSentisBlock);
  if (sentis) return sentis;
  // Otherwise fall back to a TFLite-bearing target.
  for (const wanted of TARGET_PRIORITY) {
    const hit = enabled.find((t) => (t.format || '').toLowerCase() === wanted);
    if (hit) return hit;
  }
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
      isSentisBlock: isSentisBlock(target),
      targetName: target.name,
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
      isSentisBlock: isSentisBlock(target),
      targetName: target.name,
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
      isSentisBlock: isSentisBlock(target),
      targetName: target.name,
      // For debugging: every enabled target the project sees, so the user
      // can verify whether the Sentis custom block is reaching them.
      availableTargets: targets
        .filter((t) => !t.disabledForProject)
        .map((t) => ({
          name: t.name,
          format: t.format,
          uiSection: t.uiSection,
          isSentis: isSentisBlock(t),
        })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[build-deployment] GET status check failed for project ${id}:`, message);
    return Response.json({ error: message }, { status: 502 });
  }
}
