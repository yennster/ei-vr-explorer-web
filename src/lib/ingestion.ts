const INGESTION = 'https://ingestion.edgeimpulse.com';

export type Sensor = { name: string; units: string };

/**
 * Edge Impulse JSON envelope. `values` is shaped [N_samples][N_axes].
 * Header `protected.iat` is seconds since epoch.
 */
export type EdgeImpulseSample = {
  protected: { ver: 'v1'; alg: 'none'; iat: number };
  signature: 'empty';
  payload: {
    device_name: string;
    device_type: string;
    interval_ms: number;
    sensors: Sensor[];
    values: number[][];
  };
};

export function buildSample(input: {
  deviceName: string;
  deviceType: string;
  intervalMs: number;
  sensors: Sensor[];
  values: number[][];
}): EdgeImpulseSample {
  return {
    protected: { ver: 'v1', alg: 'none', iat: Math.floor(Date.now() / 1000) },
    signature: 'empty',
    payload: {
      device_name: input.deviceName,
      device_type: input.deviceType,
      interval_ms: input.intervalMs,
      sensors: input.sensors,
      values: input.values,
    },
  };
}

export async function uploadSample(opts: {
  apiKey: string;
  category: 'training' | 'testing' | 'anomaly';
  label: string;
  fileName: string;
  sample: EdgeImpulseSample;
}): Promise<void> {
  const res = await fetch(`${INGESTION}/api/${opts.category}/data`, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'x-label': opts.label,
      'x-file-name': opts.fileName,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.sample),
  });
  if (!res.ok) {
    throw new Error(`Ingestion failed (${res.status}): ${await res.text()}`);
  }
}
