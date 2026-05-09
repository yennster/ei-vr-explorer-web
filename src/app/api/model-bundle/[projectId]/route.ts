import { type NextRequest } from 'next/server';
import JSZip from 'jszip';
import { EdgeImpulseClient } from '@/lib/edge-impulse';
import { pickPreferredTarget } from '@/lib/pick-target';
import { extractTFLiteFromDeploymentZip } from '@/lib/tflite-extract';

/**
 * GET /api/model-bundle/:projectId
 * Header: x-api-key
 *
 * Two paths, decided by pickPreferredTarget:
 *
 *   A. Sentis path (target.isSentis === true): EI's deploy.zip already
 *      contains model.onnx — extract that and stream. No conversion.
 *      Triggered by either a real /deployment/targets match OR a recent
 *      org-* build from /deployment/history (workaround — see TODO in
 *      unity-app/README.md).
 *
 *   B. TFLite extract+convert fallback: arduino/android-cpp/wasm zip,
 *      extract the C-array, run tflite2onnx via /api/convert.
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
  const picked = await pickPreferredTarget(ei, targets);
  if (picked.kind === 'no-target') {
    return Response.json(
      { error: 'No deployable target. Try arduino/android-cpp/wasm or install the Sentis custom block.' },
      { status: 422 },
    );
  }
  const target = picked.target;

  // Ensure the build exists. Skip if synthesized from history — we already
  // know there's at least one prior build.
  if (!target.fromHistory) {
    let exists;
    try {
      exists = await ei.getDeployment(target.format, target.engine);
    } catch (err) {
      return Response.json(
        { error: `Status check failed: ${err instanceof Error ? err.message : err}` },
        { status: 502 },
      );
    }
    if (!exists.hasDeployment) {
      let jobId: number;
      try {
        jobId = (await ei.buildOnDeviceModel(target.format, target.engine)).id;
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
  }

  // Download the deploy zip.
  let zipBytes: ArrayBuffer;
  try {
    zipBytes = await ei.downloadDeployment(target.format, target.engine);
  } catch (err) {
    return Response.json(
      { error: `Failed to download deploy: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }

  // ---- Sentis path -----------------------------------------------------
  if (target.isSentis) {
    let onnxBytes: ArrayBuffer;
    try {
      const zip = await JSZip.loadAsync(zipBytes);
      const modelFile = Object.values(zip.files).find(
        (f) => !f.dir && f.name.toLowerCase().endsWith('model.onnx'),
      );
      if (!modelFile) {
        const names = Object.keys(zip.files).slice(0, 20).join(', ');
        return Response.json(
          {
            error:
              `model.onnx missing from custom-block bundle (format=${target.format}). ` +
              `Files: ${names}`,
          },
          { status: 502 },
        );
      }
      const buf = await modelFile.async('uint8array');
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
        'X-Model-Engine': target.engine,
        'X-Source': target.fromHistory ? 'sentis-block-via-history' : 'sentis-block',
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
      'X-Model-Engine': target.engine,
      'X-Source': 'tflite-convert',
    },
  });
}
