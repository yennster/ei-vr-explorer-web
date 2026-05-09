import JSZip from 'jszip';

/**
 * Edge Impulse's `arduino` deploy target packages the trained TFLite model as
 * a C byte array inside a header/cpp file (path varies across versions, but
 * always lives somewhere under `tflite-model/`). This module unzips the
 * deployment archive, finds that file, and parses the array back into raw
 * TFLite bytes — which can then be fed to tflite2onnx.
 */

export async function extractTFLiteFromArduinoZip(zipBytes: ArrayBuffer): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(zipBytes);
  // Match common variants:
  //   tflite-trained.h, tflite-trained.cpp, tflite_trained_model.h, etc.
  const candidate = Object.values(zip.files).find((f) => {
    if (f.dir) return false;
    const lower = f.name.toLowerCase();
    return /tflite[-_]model\//.test(lower)
      && /(tflite[-_]trained|trained_model)\.(h|cpp|c)$/.test(lower);
  });
  if (!candidate) {
    const names = Object.keys(zip.files).filter((n) => /tflite/i.test(n)).slice(0, 20);
    throw new Error(
      `No tflite-trained.{h,cpp} found in zip. ` +
      `tflite-related files: ${names.join(', ') || '(none)'}`,
    );
  }
  const text = await candidate.async('string');
  return parseCByteArray(text);
}

/**
 * Parse a C byte array literal back into a Uint8Array.
 * Matches forms like:
 *   const unsigned char ei_tflite_trained_model[] = { 0x18, 0x00, ..., 0xff };
 * Tolerates whitespace, line continuations, and trailing length declarations.
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
      // Skip unknown tokens (some files have inline comments or stray macros).
      continue;
    }
    if (!Number.isFinite(n) || n < -128 || n > 255) continue;
    out[written++] = n & 0xff;
  }
  if (written < 16) {
    throw new Error(`Parsed only ${written} bytes — file format unexpected`);
  }
  return out.subarray(0, written);
}
