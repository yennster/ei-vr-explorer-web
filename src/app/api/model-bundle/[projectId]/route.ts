import { type NextRequest } from 'next/server';
import JSZip from 'jszip';
import {
  EdgeImpulseClient,
  type DeploymentTarget,
  type ModelEngine,
} from '@/lib/edge-impulse';
import { extractTFLiteFromDeploymentZip } from '@/lib/tflite-extract';

const TARGET_PRIORITY = ['arduino', 'android-cpp', 'wasm-browser-simd', 'wasm', 'zip'];
const ENGINE: ModelEngine = 'tflite';

function isSentisBlock(t: DeploymentTarget): boolean {
  const f = (t.format || '').toLowerCase();
  const n = (t.name || '').toLowerCase();
  const d = (t.description || '').toLowerCase();
  return n.includes('sentis')
      || f.includes('sentis')
      || (n.includes('unity') && (n.includes('onnx') || d.includes('onnx + c#')));
}

function pickTarget(targets: DeploymentTarget[]): DeploymentTarget | null {
  const enabled = targets.filter((t) => !t.disabledForProject);
  // Prefer the Unity Sentis custom block — short-circuits the entire
  // extract-and-convert pipeline.
  const sentis = enabled.find(isSentisBlock);
  if (sentis) return sentis;
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
 * Two paths:
 *
 *   A. Sentis custom block path (preferred when installed):
 *      EI's deploy.zip already contains model.onnx — extract that and
 *      stream. No conversion needed.
 *
 *   B. TFLite extract+convert fallback:
 *      Use the universally-available `arduino` (or fallback) deploy with
 *      the plain `tflite` engine, extract the TFLite from the C-array
 *      inside the zip, run tflite2onnx via /api/convert, stream the ONNX
 *      back. Slower but works on any Edge Impulse project.
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
      { error: `No suitable deploy target. Looked for Unity Sentis block or one of ${TARGET_PRIORITY.join('/')}.` },
      { status: 422 },
    );
  }
  const engine: ModelEngine = target.supportedEngines.includes(ENGINE)
    ? ENGINE
    : (target.supportedEngines[0] ?? 'tflite');
  const useSentis = isSentisBlock(target);

  // Ensure the build exists.
  let exists;
  try {
    exists = await ei.getDeployment(target.format, engine);
  } catch (err) {
    return Response.json(
      { error: `Status check failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  if (!exists.hasDeployment) {
    let jobId: number;
    try {
      jobId = (await ei.buildOnDeviceModel(target.format, engine)).id;
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
    zipBytes = await ei.downloadDeployment(target.format, engine);
  } catch (err) {
    return Response.json(
      { error: `Failed to download deploy: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // ---- Sentis custom-block path -----------------------------------------
  if (useSentis) {
    let onnxBytes: ArrayBuffer;
    try {
      const zip = await JSZip.loadAsync(zipBytes);
      const modelFile = Object.values(zip.files).find(
        (f) => !f.dir && f.name.toLowerCase().endsWith('model.onnx'),
      );
      if (!modelFile) {
        const names = Object.keys(zip.files).slice(0, 20).join(', ');
        return Response.json(
          { error: `model.onnx missing from Sentis bundle. Files: ${names}` },
          { status: 502 },
        );
      }
      const buf = await modelFile.async('uint8array');
      // Copy into a fresh ArrayBuffer to satisfy strict typing — JSZip
      // returns Uint8Array<ArrayBuffer | SharedArrayBuffer>.
      const fresh = new ArrayBuffer(buf.byteLength);
      new Uint8Array(fresh).set(buf);
      onnxBytes = fresh;
    } catch (err) {
      return Response.json(
        { error: `Sentis bundle parse failed: ${err instanceof Error ? err.message : err}` },
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
        'X-Model-Engine': engine,
        'X-Source': 'sentis-block',
      },
    });
  }

  // ---- Legacy TFLite extract + convert path -----------------------------
  let tfliteBytes: Uint8Array;
  try {
    tfliteBytes = await extractTFLiteFromDeploymentZip(zipBytes);
  } catch (err) {
    return Response.json(
      { error: `TFLite extraction failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

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
      'X-Model-Engine': engine,
      'X-Source': 'tflite-convert',
    },
  });
}
