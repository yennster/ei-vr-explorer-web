import {
  EdgeImpulseClient,
  type DeploymentTarget,
  type ModelEngine,
} from './edge-impulse';

const TARGET_PRIORITY = ['arduino', 'android-cpp', 'wasm-browser-simd', 'wasm', 'zip'];
const PREFERRED_ENGINE: ModelEngine = 'tflite';

/** Match anything that looks like a Unity Sentis custom deployment block. */
export function isSentisBlock(t: DeploymentTarget): boolean {
  const f = (t.format || '').toLowerCase();
  const n = (t.name || '').toLowerCase();
  const d = (t.description || '').toLowerCase();
  return n.includes('sentis')
      || f.includes('sentis')
      || (n.includes('unity') && (n.includes('onnx') || d.includes('onnx + c#')));
}

/** Truthy when the picked target was synthesized from /deployment/history
 * because /deployment/targets didn't expose the custom org block. See the
 * TODO in unity-app's README and the comment in pickPreferredTarget. */
export type PickedTarget = {
  format: string;
  name: string;
  engine: ModelEngine;
  isSentis: boolean;
  fromHistory: boolean;
};

export type PickResult =
  | { kind: 'picked'; target: PickedTarget }
  | { kind: 'no-target'; availableFormats: string[] };

/**
 * Decides which deployment target to use for this project.
 *
 * Order of preference:
 *   1. A Sentis-flagged target in /deployment/targets (regex match against
 *      name/format/description).
 *   2. **Workaround**: a recent custom-org-block build from /deployment/history
 *      (format starts with `org-`). EI's targets API doesn't reliably surface
 *      org-level custom blocks for custom-deployed projects — they show up in
 *      history once built, but not in the live targets list. We treat any
 *      org-* build as if it's our Sentis bundle, since that's the only
 *      custom block this companion is designed to consume. See TODO in
 *      unity-app/README.md.
 *   3. Fall back to a TFLite-bearing target (arduino/android-cpp/wasm) for
 *      the extract-and-convert path.
 */
export async function pickPreferredTarget(
  ei: EdgeImpulseClient,
  targets: DeploymentTarget[],
): Promise<PickResult> {
  const enabled = targets.filter((t) => !t.disabledForProject);

  // 1. Real Sentis match in /deployment/targets.
  const sentis = enabled.find(isSentisBlock);
  if (sentis) {
    const engine: ModelEngine = sentis.supportedEngines.includes(PREFERRED_ENGINE)
      ? PREFERRED_ENGINE
      : (sentis.supportedEngines[0] ?? 'tflite');
    return {
      kind: 'picked',
      target: {
        format: sentis.format,
        name: sentis.name,
        engine,
        isSentis: true,
        fromHistory: false,
      },
    };
  }

  // 2. Workaround: scan recent history for an org-* deployment.
  //    TODO(EI): remove this branch once /deployment/targets correctly
  //    exposes custom org blocks with display names.
  try {
    const history = await ei.listDeploymentHistory({ limit: 10 });
    const orgBuild = history.deployments?.find(
      (d) => d.deploymentFormat && d.deploymentFormat.startsWith('org-'),
    );
    if (orgBuild) {
      return {
        kind: 'picked',
        target: {
          format: orgBuild.deploymentFormat,
          name: orgBuild.deploymentTarget?.name || `Custom org block (${orgBuild.deploymentFormat})`,
          engine: orgBuild.engine,
          isSentis: true, // assumed — see TODO
          fromHistory: true,
        },
      };
    }
  } catch {
    // History endpoint failure isn't fatal; fall through to TFLite path.
  }

  // 3. TFLite-bearing fallback.
  for (const wanted of TARGET_PRIORITY) {
    const hit = enabled.find((t) => (t.format || '').toLowerCase() === wanted);
    if (hit) {
      const engine: ModelEngine = hit.supportedEngines.includes(PREFERRED_ENGINE)
        ? PREFERRED_ENGINE
        : (hit.supportedEngines[0] ?? 'tflite');
      return {
        kind: 'picked',
        target: {
          format: hit.format,
          name: hit.name,
          engine,
          isSentis: false,
          fromHistory: false,
        },
      };
    }
  }
  // Last-ditch: any target that supports plain tflite engine.
  const lastDitch = enabled.find((t) => t.supportedEngines.includes('tflite'));
  if (lastDitch) {
    return {
      kind: 'picked',
      target: {
        format: lastDitch.format,
        name: lastDitch.name,
        engine: 'tflite',
        isSentis: false,
        fromHistory: false,
      },
    };
  }

  return {
    kind: 'no-target',
    availableFormats: targets.map((t) => t.format).filter(Boolean),
  };
}
