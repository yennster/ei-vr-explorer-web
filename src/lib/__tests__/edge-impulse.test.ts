import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { listProjectsForKey, EdgeImpulseClient } from '../edge-impulse';

const STUDIO_PROJECTS = 'https://studio.edgeimpulse.com/v1/api/projects';

describe('listProjectsForKey', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the projects array on success', async () => {
    const mockBody = { success: true, projects: [{ id: 42, name: 'Demo motion' }] };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(mockBody), { status: 200 }),
    );
    const out = await listProjectsForKey('ei_test');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 42, name: 'Demo motion' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      STUDIO_PROJECTS,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'ei_test' }) }),
    );
  });

  it('throws a real Error with EI message on success:false', async () => {
    const mockBody = { success: false, error: 'API key not found' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(mockBody), { status: 200 }),
    );
    await expect(listProjectsForKey('bad')).rejects.toThrow(/API key not found/);
  });

  it('throws on non-JSON response', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('<html>500 Internal Server Error</html>', { status: 500 }),
    );
    await expect(listProjectsForKey('x')).rejects.toThrow(/HTTP 500/);
  });
});

describe('EdgeImpulseClient', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends x-api-key header on requests', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, project: { id: 7, name: 'P' } }), { status: 200 }),
    );
    const c = new EdgeImpulseClient('ei_test', 7);
    await c.getProject();
    const callArgs = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ei_test');
  });

  it('builds the feature-graph URL with all axis params', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, totalSampleCount: 0, data: [], skipFirstFeatures: 0 }), { status: 200 }),
    );
    const c = new EdgeImpulseClient('ei_test', 7);
    await c.getFeatureGraph(13, 'training', { x: 0, y: 1, z: 2 });
    const calledUrl = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    const u = calledUrl.toString();
    expect(u).toContain('/dsp/13/features/get-graph/training');
    expect(u).toContain('featureAx1=0');
    expect(u).toContain('featureAx2=1');
    expect(u).toContain('featureAx3=2');
  });
});
