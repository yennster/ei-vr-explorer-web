const STUDIO = 'https://studio.edgeimpulse.com/v1';

export type EdgeImpulseError = {
  status: number;
  message: string;
};

/**
 * GET /api/projects with an API key returns just the projects that key has
 * access to. For a project-scoped key (the common case), that's a single
 * project — which lets us derive the project ID without asking the user.
 *
 * Throws a real Error with a useful message so the calling route can surface
 * EI's actual rejection reason to the user.
 */
export async function listProjectsForKey(apiKey: string): Promise<Array<{ id: number; name: string }>> {
  const res = await fetch(`${STUDIO}/api/projects`, {
    headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
  });
  const text = await res.text();
  let data: { success?: boolean; error?: string; projects?: Array<{ id: number; name: string }> } | null = null;
  try { data = JSON.parse(text); } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
  }
  return data?.projects ?? [];
}

export class EdgeImpulseClient {
  constructor(
    private readonly apiKey: string,
    private readonly projectId: number,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(`${STUDIO}${path}`);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw <EdgeImpulseError>{ status: res.status, message: text || res.statusText };
    }
    if (!res.ok || (data as { success?: boolean }).success === false) {
      throw <EdgeImpulseError>{
        status: res.status,
        message: (data as { error?: string }).error || res.statusText,
      };
    }
    return data as T;
  }

  // GET /api/{projectId}
  getProject() {
    return this.request<ProjectInfoResponse>('GET', `/api/${this.projectId}`);
  }

  // GET /api/{projectId}/impulse
  getImpulse() {
    return this.request<ImpulseResponse>('GET', `/api/${this.projectId}/impulse`);
  }

  // GET /api/{projectId}/dsp/{dspId}/features/labels
  getFeatureLabels(dspId: number) {
    return this.request<FeatureLabelsResponse>(
      'GET',
      `/api/${this.projectId}/dsp/${dspId}/features/labels`,
    );
  }

  // GET /api/{projectId}/dsp/{dspId}/features/importance
  getFeatureImportance(dspId: number) {
    return this.request<FeatureImportanceResponse>(
      'GET',
      `/api/${this.projectId}/dsp/${dspId}/features/importance`,
    );
  }

  // GET /api/{projectId}/dsp/{dspId}/features/get-graph/{category}
  // The 3D feature scatter — the linchpin endpoint for the VR explorer.
  getFeatureGraph(
    dspId: number,
    category: 'training' | 'testing',
    axes: { x: number; y: number; z: number },
  ) {
    return this.request<FeatureGraphResponse>(
      'GET',
      `/api/${this.projectId}/dsp/${dspId}/features/get-graph/${category}`,
      { query: { featureAx1: axes.x, featureAx2: axes.y, featureAx3: axes.z } },
    );
  }

  // GET /api/{projectId}/raw-data/{sampleId}/slice
  getSampleSlice(sampleId: number, query?: { sliceStart?: number; sliceEnd?: number }) {
    return this.request<SampleSliceResponse>(
      'GET',
      `/api/${this.projectId}/raw-data/${sampleId}/slice`,
      { query },
    );
  }

  // POST /api/{projectId}/deploy  body: { deployType }
  startDeploy(deployType: 'tflite' | 'zip' | 'arduino' | 'onnx' = 'tflite') {
    return this.request<{ success: true }>('POST', `/api/${this.projectId}/deploy`, {
      body: { deployType },
    });
  }

  // GET /api/{projectId}/deploy
  getDeployArtifact() {
    return this.request<DeployArtifactResponse>('GET', `/api/${this.projectId}/deploy`);
  }

  // POST /api/{projectId}/jobs/train
  startTrain() {
    return this.request<JobStartResponse>('POST', `/api/${this.projectId}/jobs/train`);
  }

  // GET /api/{projectId}/jobs/{jobId}/status
  getJobStatus(jobId: number) {
    return this.request<JobStatusResponse>('GET', `/api/${this.projectId}/jobs/${jobId}/status`);
  }

  // GET /api/{projectId}/jobs/{jobId}/stdout/download — returns plain text
  async getJobStdout(jobId: number): Promise<string> {
    const res = await fetch(
      `${STUDIO}/api/${this.projectId}/jobs/${jobId}/stdout/download`,
      { headers: { 'x-api-key': this.apiKey } },
    );
    if (!res.ok) throw <EdgeImpulseError>{ status: res.status, message: res.statusText };
    return res.text();
  }
}

// ---------- Response types (only the fields we actually use) ----------

export type ProjectInfoResponse = {
  success: true;
  project: { id: number; name: string; logo?: string };
};

export type ImpulseResponse = {
  success: true;
  impulse: {
    inputBlocks: Array<{ id: number; name: string; type: string }>;
    dspBlocks: Array<{ id: number; name: string; type: string; axes?: string[] }>;
    learnBlocks: Array<{ id: number; name: string; type: string; classes?: string[] }>;
  };
};

export type FeatureLabelsResponse = {
  success: true;
  labels: string[]; // e.g. ["RMS", "Skewness", "Kurtosis", ...] indexed by feature id
};

export type FeatureImportanceResponse = {
  success: true;
  features: Array<{ label: string; importance: number; index: number }>;
};

export type FeatureGraphPoint = {
  X: Record<string, number>; // featureIndex (string) -> value
  y: number;
  yLabel: string;
  sample: { id: number; name: string; startMs: number; endMs: number };
};

export type FeatureGraphResponse = {
  success: true;
  totalSampleCount: number;
  data: FeatureGraphPoint[];
  skipFirstFeatures: number;
};

export type SampleSliceResponse = {
  success: true;
  data: { values: number[][]; sensors: Array<{ name: string; units: string }> };
};

export type DeployArtifactResponse = {
  success: true;
  hasDeployment: boolean;
  // When ready, EI returns a URL or signed redirect for the artifact;
  // shape varies by deployType. The client should follow the URL.
  url?: string;
};

export type JobStartResponse = {
  success: true;
  id: number; // jobId
};

export type JobStatusResponse = {
  success: true;
  job: {
    id: number;
    finished: boolean;
    finishedSuccessful?: boolean;
    created?: string;
    started?: string;
    finishedDate?: string;
  };
};
