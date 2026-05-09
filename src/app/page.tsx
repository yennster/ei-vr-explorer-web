'use client';

import { useState } from 'react';
import QRCode from 'qrcode';

type PairResponse = {
  code: string;
  projectId: number;
  projectName: string;
  expiresAt: number;
};

const EI_PURPLE = '#3b47c2';
const EI_PURPLE_HOVER = '#2a2aea';

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [pair, setPair] = useState<PairResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = (await res.json()) as PairResponse | { error: string };
      if (!res.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : 'Pairing failed');
      }
      setPair(data);
      const payload = JSON.stringify({
        baseUrl: window.location.origin,
        code: data.code,
      });
      setQrDataUrl(await QRCode.toDataURL(payload, { margin: 1, width: 280 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
        <form onSubmit={submit} className="flex flex-col gap-4">
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
            }}
            className="text-xs underline"
            style={{ color: EI_PURPLE }}
          >
            Generate a new code
          </button>
        </section>
      )}
    </main>
  );
}
