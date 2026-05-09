# Edge Impulse VR Explorer — Web Companion

Vercel-hosted Next.js companion app for the Edge Impulse VR Explorer
Quest 2 app. Handles:

- **Pairing** — paste an Edge Impulse project API key (project ID is
  detected automatically), get a 6-digit code + QR the headset can pick up.
- **Model bundle** — picks a TFLite-bearing deploy target on Edge Impulse
  (`arduino` / `android-cpp` / `wasm`), triggers the build, downloads the
  zip, extracts the embedded TFLite, and converts to ONNX server-side via
  a Python `tflite2onnx` function. Streams the ONNX bytes to the headset.
- **Ingestion proxy** — forwards new IMU / audio samples captured on the
  Quest to the Edge Impulse Ingestion API.
- **Retrain proxy** — kicks off training jobs and surfaces status / stdout
  back to the headset for the in-VR progress HUD.

## Related repos

- **[ei-vr-explorer-unity](https://github.com/yennster/ei-vr-explorer-unity)** —
  the Quest 2 Unity client this companion pairs with.
- **[ei-unity-sentis-block](https://github.com/yennster/ei-unity-sentis-block)** —
  Edge Impulse custom deployment block. Enterprise orgs that install it can
  skip the companion's extract/convert hops entirely; the block produces a
  ready-to-use `deploy.zip` directly from the Studio Deployment page.

## Local dev

```bash
npm install
npm run dev    # http://localhost:3000
```

Without Upstash configured, pairing codes are kept in memory (fine for dev,
not for prod with multiple function instances).

## Deploy

```bash
npm i -g vercel  # one-time
vercel link
vercel deploy --prod
```

Add **Upstash Redis** from the Vercel Marketplace — it auto-injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN`.

## API surface

| Route | Purpose |
|---|---|
| `POST /api/pair` | Validate creds, mint a 6-digit pairing code (5 min TTL) |
| `GET  /api/pair?code=NNNNNN` | Headset polls with code, retrieves creds (one-time) |
| `GET  /api/model-bundle/:projectId` | Trigger + poll TFLite build, return artifact URL |
| `POST /api/ingest` | Forward a captured sample to EI Ingestion API |
| `POST /api/retrain/:projectId` | Trigger a training job, return jobId |
| `GET  /api/retrain/:projectId?jobId=N` | Poll training status + stdout tail |

The Studio API client lives in [`src/lib/edge-impulse.ts`](src/lib/edge-impulse.ts);
the Ingestion API helper in [`src/lib/ingestion.ts`](src/lib/ingestion.ts).
