import { type NextRequest } from 'next/server';
import {
  EdgeImpulseClient,
  type DeploymentTarget,
  type ModelEngine,
} from '@/lib/edge-impulse';
import { extractTFLiteFromArduinoZip } from '@/lib/tflite-extract';

const TARGET_PRIORITY = ['arduino', 'android-cpp', 'wasm-browser-simd', 'wasm', 'zip'];
const ENGINE: ModelEngine = 'tflite';

function pickTarget(targets: DeploymentTarget[]): DeploymentTarget | null {
  const enabled = targets.filter((t) => !t.disabledForProject);
  for (const wanted of TARGET_PRIORITY) {
    const hit = enabled.find((t) => (t.format || '').toLowerCase() === wanted);
    if (hit) return hit;
  }
  return enabled.find((t) => t.supportedEngines.includes('tflite')) ?? null;
}

/**
 * GET /api/model-bundle/:projectId
 * Header: x-api-key
 *
 * Returns the model as ONNX bytes the headset can write straight to disk.
 *
 * EI doesn't expose ONNX as a deploy block for most projects, so we go via
 * the universally-available `arduino` (or fallback) deploy with the plain
 * `tflite` engine, extract the TFLite flatbuffer from the C-array inside the
 * zip, then call our Python /api/convert function (tflite2onnx) to produce
 * an ONNX model. Unity Sentis loads the result directly.
 *
 * The full pipeline runs server-side per request. For typical EI motion /
 * audio / FOMO models conversion takes a few seconds.
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

  // Pick a TFLite-bearing target.
  let targets;
  try {
    targets = (await ei.listDeploymentTargets()).targets;
  } catch (err) {
    return Response.json(
      { error: `Listing deployment targets failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  const target = pickTarget(targets);
  if (!target) {
    return Response.json(
      { error: `No TFLite-bearing deploy target available. Looked for ${TARGET_PRIORITY.join('/')}.` },
      { status: 422 },
    );
  }

  // Ensure the build exists.
  let exists;
  try {
    exists = await ei.getDeployment(target.format, ENGINE);
  } catch (err) {
    return Response.json(
      { error: `Status check failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  if (!exists.hasDeployment) {
    // Kick off a build and poll. Cap at 4 min to leave time for download + convert.
    let jobId: number;
    try {
      jobId = (await ei.buildOnDeviceModel(target.format, ENGINE)).id;
    } catch (err) {
      return Response.json(
        { error: `Failed to start build: ${err instanceof Error ? err.message : err}` },
        { status: 502 },
      );
    }
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const status = await ei.getJobStatus(jobId).catch(() => null);
      if (!status) continue;
      if (!status.job.finished) continue;
      if (!status.job.finishedSuccessful) {
        return Response.json({ error: 'EI build job failed', jobId }, { status: 502 });
      }
      break;
    }
  }

  // Download the deploy zip.
  let zipBytes: ArrayBuffer;
  try {
    zipBytes = await ei.downloadDeployment(target.format, ENGINE);
  } catch (err) {
    return Response.json(
      { error: `Failed to download deploy: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // Extract the TFLite flatbuffer from inside the C-array header.
  let tfliteBytes: Uint8Array;
  try {
    tfliteBytes = await extractTFLiteFromArduinoZip(zipBytes);
  } catch (err) {
    return Response.json(
      { error: `TFLite extraction failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // Convert TFLite → ONNX via the sibling Python function.
  const convertUrl = new URL(
    '/api/convert',
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(request.url).origin,
  );
  let onnxBytes: ArrayBuffer;
  try {
    const convertRes = await fetch(convertUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([tfliteBytes.buffer as ArrayBuffer]),
    });
    if (!convertRes.ok) {
      const errText = await convertRes.text().catch(() => convertRes.statusText);
      return Response.json(
        { error: `Conversion failed (HTTP ${convertRes.status}): ${errText}` },
        { status: 502 },
      );
    }
    onnxBytes = await convertRes.arrayBuffer();
  } catch (err) {
    return Response.json(
      { error: `Conversion request failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  return new Response(onnxBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(onnxBytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Model-Type': target.format,
      'X-Model-Engine': ENGINE,
    },
  });
}
