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
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    if (!res.ok || (data as { success?: boolean }).success === false) {
      const eiError = (data as { error?: string }).error;
      throw new Error(eiError || `HTTP ${res.status}: ${res.statusText}`);
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

  // POST /api/{projectId}/deploy  body: { deployType } — legacy
  startDeploy(deployType: 'tflite' | 'zip' | 'arduino' | 'onnx' = 'onnx') {
    return this.request<{ success: true }>('POST', `/api/${this.projectId}/deploy`, {
      body: { deployType },
    });
  }

  // GET /api/{projectId}/deploy — legacy
  getDeployArtifact() {
    return this.request<DeployArtifactResponse>('GET', `/api/${this.projectId}/deploy`);
  }

  // GET /api/{projectId}/deployment/targets
  // Lists deployment formats available for this project. Each target has a
  // `format` string — that's what the `type=` query expects elsewhere.
  listDeploymentTargets() {
    return this.request<DeploymentTargetsResponse>(
      'GET',
      `/api/${this.projectId}/deployment/targets`,
    );
  }

  // GET /api/{projectId}/deployment?type=&engine=
  // Returns whether a build artifact already exists for the given combo.
  // `type` is the format string from listDeploymentTargets().
  getDeployment(type: string, engine: ModelEngine) {
    return this.request<GetDeploymentResponse>('GET', `/api/${this.projectId}/deployment`, {
      query: { type, engine },
    });
  }

  // POST /api/{projectId}/jobs/build-ondevice-model?type=
  // body: { engine, modelType? } — kicks off a build and returns a jobId.
  buildOnDeviceModel(type: string, engine: ModelEngine, modelType: 'float32' | 'int8' = 'float32') {
    return this.request<JobStartResponse>(
      'POST',
      `/api/${this.projectId}/jobs/build-ondevice-model`,
      { query: { type }, body: { engine, modelType } },
    );
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

// ---------- Public types ----------

export type DeployType = 'onnx' | 'tflite' | 'zip' | 'arduino';
export type ModelEngine = 'tflite' | 'tflite-eon' | 'tflite-eon-ram-optimized';

// ---------- Response types (only the fields we actually use) ----------

export type GetDeploymentResponse = {
  success: true;
  hasDeployment: boolean;
  version?: number;
};

export type DeploymentTarget = {
  name: string;
  description: string;
  format: string; // <-- the `type` value to pass to /deployment and /jobs/build-ondevice-model
  supportedEngines: ModelEngine[];
  hasEonCompiler: boolean;
  recommendedForProject?: boolean;
  disabledForProject?: boolean;
  reasonTargetDisabled?: string;
  uiSection?: string;
};

export type DeploymentTargetsResponse = {
  success: true;
  targets: DeploymentTarget[];
};

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
