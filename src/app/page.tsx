'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

type PairResponse = {
  code: string;
  projectId: number;
  projectName: string;
  expiresAt: number;
};

type DeployStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'missing'; type: string; engine: string }
  | { kind: 'no-target'; availableFormats: string[] }
  | { kind: 'ready'; version?: number; type: string; engine: string }
  | { kind: 'building' }
  | { kind: 'error'; message: string };

const EI_PURPLE = '#3b47c2';
const EI_PURPLE_HOVER = '#2a2aea';

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [pair, setPair] = useState<PairResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deploy, setDeploy] = useState<DeployStatus>({ kind: 'idle' });
  const autoSubmitted = useRef(false);

  const runPair = useCallback(async (keyToUse: string) => {
    setError(null);
    setBusy(true);
    try {
      const trimmed = keyToUse.trim();
      if (!trimmed) throw new Error('Paste an Edge Impulse API key');

      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: trimmed }),
      });

      let data: PairResponse | { error?: unknown } | null = null;
      try {
        data = (await res.json()) as PairResponse | { error?: unknown };
      } catch {
        throw new Error(`Pairing failed (HTTP ${res.status}) — server response was not JSON`);
      }

      if (!res.ok || (data && 'error' in data)) {
        const raw = (data as { error?: unknown })?.error;
        const msg =
          typeof raw === 'string'
            ? raw
            : raw != null
              ? JSON.stringify(raw)
              : `Pairing failed (HTTP ${res.status})`;
        throw new Error(msg);
      }

      const ok = data as PairResponse;
      setApiKey(trimmed); // keep so the build button can authenticate
      setPair(ok);
      const payload = JSON.stringify({ baseUrl: window.location.origin, code: ok.code });
      setQrDataUrl(await QRCode.toDataURL(payload, { margin: 1, width: 280 }));
    } catch (err) {
      console.error('[pair] failed', err);
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : err && typeof err === 'object'
              ? JSON.stringify(err)
              : 'Pairing failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  // Auto-fill + auto-submit when ?apiKey=ei_... is in the URL.
  useEffect(() => {
    if (autoSubmitted.current) return;
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('apiKey');
    if (!fromUrl) return;
    autoSubmitted.current = true;
    setApiKey(fromUrl);
    url.searchParams.delete('apiKey');
    window.history.replaceState({}, '', url.toString());
    void runPair(fromUrl);
  }, [runPair]);

  // After pairing, check whether the ONNX+EON deployment already exists.
  useEffect(() => {
    if (!pair || !apiKey) return;
    let cancelled = false;
    setDeploy({ kind: 'checking' });
    (async () => {
      try {
        const res = await fetch(`/api/build-deployment/${pair.projectId}`, {
          headers: { 'x-api-key': apiKey },
        });
        type CheckOk = {
          hasDeployment: boolean;
          targetFound: boolean;
          version?: number;
          type?: string;
          engine?: string;
          availableFormats?: string[];
        };
        const data = (await res.json()) as CheckOk | { error: string };
        if (cancelled) return;
        if (!res.ok || 'error' in data) {
          setDeploy({ kind: 'error', message: 'error' in data ? data.error : `HTTP ${res.status}` });
          return;
        }
        if (!data.targetFound) {
          setDeploy({ kind: 'no-target', availableFormats: data.availableFormats ?? [] });
          return;
        }
        if (data.hasDeployment) {
          setDeploy({
            kind: 'ready',
            version: data.version,
            type: data.type ?? '',
            engine: data.engine ?? '',
          });
        } else {
          setDeploy({ kind: 'missing', type: data.type ?? '', engine: data.engine ?? '' });
        }
      } catch (err) {
        if (cancelled) return;
        setDeploy({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [pair, apiKey]);

  async function buildDeployment() {
    if (!pair || !apiKey) return;
    setDeploy({ kind: 'building' });
    try {
      const res = await fetch(`/api/build-deployment/${pair.projectId}`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
      });
      type BuildOk = {
        built: true;
        alreadyExisted?: boolean;
        version?: number;
        durationMs?: number;
        type?: string;
        engine?: string;
      };
      const data = (await res.json()) as BuildOk | { error: string; stdoutTail?: string };
      if (!res.ok || 'error' in data) {
        const tail = 'stdoutTail' in data && data.stdoutTail ? `\n${data.stdoutTail}` : '';
        setDeploy({
          kind: 'error',
          message: ('error' in data ? data.error : `HTTP ${res.status}`) + tail,
        });
        return;
      }
      setDeploy({
        kind: 'ready',
        version: data.version,
        type: data.type ?? '',
        engine: data.engine ?? '',
      });
    } catch (err) {
      setDeploy({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 p-8 font-sans">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Edge Impulse VR Explorer
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Pair a Quest 2 with your Edge Impulse project. Paste your project's
          API key, then scan the QR code from inside the headset.
        </p>
      </header>

      {!pair && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runPair(apiKey);
          }}
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">API key</span>
            <input
              type="password"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ei_..."
              className="rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-[var(--ei-purple)] focus:ring-2 focus:ring-[var(--ei-purple)]/30 dark:border-zinc-700 dark:bg-zinc-900"
              style={{ ['--ei-purple' as string]: EI_PURPLE }}
            />
            <span className="text-xs text-zinc-500">
              Studio → project Dashboard → Keys. Project ID is detected from the key.
              You can also pass <code className="font-mono">?apiKey=ei_...</code> in the URL to auto-pair.
            </span>
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            style={{ backgroundColor: busy ? EI_PURPLE_HOVER : EI_PURPLE }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = EI_PURPLE_HOVER)}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = busy ? EI_PURPLE_HOVER : EI_PURPLE)}
            className="rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
          >
            {busy ? 'Pairing…' : 'Generate pairing code'}
          </button>
        </form>
      )}

      {pair && (
        <>
          <section className="flex flex-col items-center gap-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Paired with{' '}
              <span className="font-semibold" style={{ color: EI_PURPLE }}>
                {pair.projectName}
              </span>{' '}
              <span className="text-zinc-500">(#{pair.projectId})</span>
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Open the VR app on your Quest and scan this code, or type:
            </p>
            <p className="font-mono text-4xl tracking-[0.4em]" style={{ color: EI_PURPLE }}>
              {pair.code}
            </p>
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Pairing QR code"
                className="rounded bg-white p-2"
              />
            )}
            <p className="text-xs text-zinc-500">Expires in 5 minutes. Single use.</p>
            <button
              onClick={() => {
                setPair(null);
                setQrDataUrl(null);
                setDeploy({ kind: 'idle' });
              }}
              className="text-xs underline"
              style={{ color: EI_PURPLE }}
            >
              Generate a new code
            </button>
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
            <h2 className="text-sm font-semibold tracking-tight">
              Model deployment (TFLite → ONNX → Sentis)
            </h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Edge Impulse doesn't expose raw ONNX, so we use the project's
              TFLite-bearing deploy (typically <code className="font-mono">arduino</code>),
              extract the <code className="font-mono">.tflite</code> from the
              zip, and convert to ONNX server-side via{' '}
              <code className="font-mono">tflite2onnx</code>. The Quest then
              loads the result with Unity Sentis.
            </p>

            {deploy.kind === 'checking' && (
              <p className="text-sm text-zinc-500">Checking deployment status…</p>
            )}

            {deploy.kind === 'ready' && (
              <p className="text-sm" style={{ color: EI_PURPLE }}>
                ✓ {deploy.type || 'TFLite'} build (engine{' '}
                <code className="font-mono">{deploy.engine || 'tflite'}</code>) is ready
                {deploy.version !== undefined && ` (version ${deploy.version})`}.
                The Quest will fetch it, the companion will convert TFLite → ONNX,
                and Sentis will load it.
              </p>
            )}

            {deploy.kind === 'missing' && (
              <>
                <p className="text-xs text-zinc-500">
                  Will build target <code className="font-mono">{deploy.type}</code> with engine{' '}
                  <code className="font-mono">{deploy.engine}</code>. Conversion to ONNX runs
                  later, when the headset asks for the model.
                </p>
                <button
                  onClick={buildDeployment}
                  style={{ backgroundColor: EI_PURPLE }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = EI_PURPLE_HOVER)}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = EI_PURPLE)}
                  className="self-start rounded-md px-4 py-2 text-sm font-medium text-white transition-colors"
                >
                  Build TFLite deployment
                </button>
              </>
            )}

            {deploy.kind === 'no-target' && (
              <pre className="whitespace-pre-wrap rounded bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {`No TFLite-bearing deploy target available for this project.\n` +
                  `Available formats: ${deploy.availableFormats.join(', ') || '(none)'}\n\n` +
                  `Expected one of: arduino, android-cpp, wasm-browser-simd, wasm, zip.`}
              </pre>
            )}

            {deploy.kind === 'building' && (
              <p className="text-sm text-zinc-500">
                Building… this usually takes 1–3 minutes. Don't close this tab.
              </p>
            )}

            {deploy.kind === 'error' && (
              <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {deploy.message}
              </pre>
            )}
          </section>
        </>
      )}
    </main>
  );
}
