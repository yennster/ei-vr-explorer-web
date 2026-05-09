import { type NextRequest } from 'next/server';
import { buildSample, uploadSample, type Sensor } from '@/lib/ingestion';

type IngestBody = {
  category: 'training' | 'testing' | 'anomaly';
  label: string;
  fileName: string;
  deviceName: string;
  deviceType: string;
  intervalMs: number;
  sensors: Sensor[];
  values: number[][];
};

/**
 * POST /api/ingest
 * Header: x-api-key
 * Body: IngestBody
 * Forwards a captured sample to the Edge Impulse Ingestion API.
 */
export async function POST(request: NextRequest) {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return Response.json({ error: 'x-api-key required' }, { status: 401 });

  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const required: (keyof IngestBody)[] = [
    'category', 'label', 'fileName', 'deviceName',
    'deviceType', 'intervalMs', 'sensors', 'values',
  ];
  for (const k of required) {
    if (body[k] === undefined) {
      return Response.json({ error: `Missing field: ${String(k)}` }, { status: 400 });
    }
  }

  try {
    await uploadSample({
      apiKey,
      category: body.category,
      label: body.label,
      fileName: body.fileName,
      sample: buildSample({
        deviceName: body.deviceName,
        deviceType: body.deviceType,
        intervalMs: body.intervalMs,
        sensors: body.sensors,
        values: body.values,
      }),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Ingestion failed' },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
