import { describe, expect, it } from 'vitest';
import { buildSample } from '../ingestion';

describe('buildSample', () => {
  it('produces an Edge Impulse JSON envelope with expected structure', () => {
    const before = Math.floor(Date.now() / 1000);
    const env = buildSample({
      deviceName: 'quest-abc',
      deviceType: 'QUEST_2',
      intervalMs: 16,
      sensors: [{ name: 'accX', units: 'm/s2' }],
      values: [[1.0], [2.0], [3.0]],
    });
    const after = Math.floor(Date.now() / 1000);

    expect(env.protected.ver).toBe('v1');
    expect(env.protected.alg).toBe('none');
    expect(env.protected.iat).toBeGreaterThanOrEqual(before);
    expect(env.protected.iat).toBeLessThanOrEqual(after);
    expect(env.signature).toBe('empty');
    expect(env.payload.device_name).toBe('quest-abc');
    expect(env.payload.device_type).toBe('QUEST_2');
    expect(env.payload.interval_ms).toBe(16);
    expect(env.payload.sensors).toHaveLength(1);
    expect(env.payload.values).toEqual([[1.0], [2.0], [3.0]]);
  });

  it('handles multi-axis IMU samples', () => {
    const env = buildSample({
      deviceName: 'q',
      deviceType: 'QUEST_2',
      intervalMs: 16,
      sensors: [
        { name: 'accX', units: 'm/s2' },
        { name: 'accY', units: 'm/s2' },
        { name: 'accZ', units: 'm/s2' },
      ],
      values: [[0, 0, 0], [1, 1, 1]],
    });
    expect(env.payload.sensors).toHaveLength(3);
    expect(env.payload.values[1]).toEqual([1, 1, 1]);
  });
});
