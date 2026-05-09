import JSZip from 'jszip';

/**
 * Pulls the raw TFLite flatbuffer out of an Edge Impulse deployment zip.
 *
 * EI ships the trained model in different shapes depending on the deploy
 * format we picked:
 *   - `arduino` and `android-cpp` zips embed the model as a C byte array
 *     in `tflite-model/tflite-trained.{h,cpp}`.
 *   - `wasm` / `wasm-browser-simd` zips often include a raw `.tflite` file
 *     alongside the WASM runtime.
 *   - `zip` is a generic library zip; it can be either of the above.
 *
 * This helper tries the raw-file path first (fast) and falls back to
 * parsing the C array (works everywhere the C++ SDK ships).
 */
export async function extractTFLiteFromDeploymentZip(zipBytes: ArrayBuffer): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(zipBytes);

  // 1. Prefer a raw .tflite file if the zip happens to ship one.
  const rawHit = Object.values(zip.files).find((f) => {
    if (f.dir) return false;
    return /\.tflite$/i.test(f.name);
  });
  if (rawHit) {
    const buf = await rawHit.async('uint8array');
    if (buf.length > 16) return buf;
  }

  // 2. Otherwise look for the standard EI tflite-model header/cpp file.
  const candidate = Object.values(zip.files).find((f) => {
    if (f.dir) return false;
    const lower = f.name.toLowerCase();
    return /tflite[-_]model\//.test(lower)
      && /(tflite[-_]trained|trained_model)\.(h|cpp|c)$/.test(lower);
  });
  if (!candidate) {
    const names = Object.keys(zip.files).filter((n) => /tflite/i.test(n)).slice(0, 20);
    throw new Error(
      `No raw .tflite or tflite-trained.{h,cpp} found in zip. ` +
      `tflite-related files: ${names.join(', ') || '(none)'}`,
    );
  }
  const text = await candidate.async('string');
  return parseCByteArray(text);
}

/** Back-compat alias for the earlier name; new code should use the generic name. */
export const extractTFLiteFromArduinoZip = extractTFLiteFromDeploymentZip;

/**
 * Parse a C byte array literal back into a Uint8Array.
 * Matches forms like:
 *   const unsigned char ei_tflite_trained_model[] = { 0x18, 0x00, ..., 0xff };
 */
export function parseCByteArray(source: string): Uint8Array {
  const arrayMatch = source.match(/=\s*\{([\s\S]*?)\}\s*;/);
  if (!arrayMatch) throw new Error('Could not locate `= { ... };` byte array literal');
  const tokens = arrayMatch[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const out = new Uint8Array(tokens.length);
  let written = 0;
  for (const tok of tokens) {
    let n: number;
    if (tok.startsWith('0x') || tok.startsWith('0X')) {
      n = parseInt(tok.slice(2), 16);
    } else if (/^-?\d+$/.test(tok)) {
      n = parseInt(tok, 10);
    } else {
      continue;
    }
    if (!Number.isFinite(n) || n < -128 || n > 255) continue;
    out[written++] = n & 0xff;
  }
  if (written < 16) throw new Error(`Parsed only ${written} bytes — file format unexpected`);
  return out.subarray(0, written);
}
