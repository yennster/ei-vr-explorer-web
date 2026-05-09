import { type NextRequest } from 'next/server';
import { EdgeImpulseClient } from '@/lib/edge-impulse';

/**
 * GET /api/model-bundle/:projectId
 * Header: x-api-key
 * Triggers a TFLite build (POST /deploy), polls the build job, then returns
 * the artifact URL the headset should download. The Vercel function timeout
 * is 300s by default which is enough for a typical EI TFLite build.
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

  // Check if a deploy artifact already exists; otherwise trigger one.
  const existing = await ei.getDeployArtifact().catch(() => null);
  if (!existing?.hasDeployment) {
    await ei.startDeploy('tflite');
    // After triggering deploy, the EI server starts a build job. There isn't a
    // "deploy job id" returned directly — instead poll getDeployArtifact()
    // until hasDeployment is true.
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const status = await ei.getDeployArtifact().catch(() => null);
      if (status?.hasDeployment) break;
    }
    const final = await ei.getDeployArtifact();
    if (!final.hasDeployment) {
      return Response.json({ error: 'TFLite build did not complete in time' }, { status: 504 });
    }
    return Response.json(final);
  }

  return Response.json(existing);
}
