import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseCByteArray, extractTFLiteFromDeploymentZip } from '../tflite-extract';

describe('parseCByteArray', () => {
  it('parses a basic hex byte array', () => {
    const src = `
      const unsigned char ei_tflite_trained_model[] = {
        0x18, 0x00, 0x00, 0x00, 0x54, 0x46, 0x4c, 0x33,
        0xff, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78,
        0x9a, 0xbc, 0xde, 0xf0
      };
      const unsigned int ei_tflite_trained_model_len = 20;
    `;
    const out = parseCByteArray(src);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThanOrEqual(16);
    expect(out[0]).toBe(0x18);
    expect(out[4]).toBe(0x54); // 'T'
    expect(out[5]).toBe(0x46); // 'F'
    expect(out[6]).toBe(0x4c); // 'L'
  });

  it('handles decimal byte values', () => {
    const fillerBytes = Array.from({ length: 20 }, (_, i) => i).join(', ');
    const src = `const unsigned char m[] = { ${fillerBytes} };`;
    const out = parseCByteArray(src);
    expect(out.length).toBeGreaterThanOrEqual(16);
    expect(out[0]).toBe(0);
    expect(out[10]).toBe(10);
    expect(out[19]).toBe(19);
  });

  it('throws when no array literal is present', () => {
    expect(() => parseCByteArray('// nothing here')).toThrow(/byte array literal/);
  });

  it('throws when too few bytes parsed', () => {
    const src = 'const unsigned char x[] = { 0x01, 0x02 };';
    expect(() => parseCByteArray(src)).toThrow(/Parsed only/);
  });
});

describe('extractTFLiteFromDeploymentZip', () => {
  it('extracts a raw .tflite file when one is present in the zip', async () => {
    const fakeTflite = new Uint8Array(64).fill(0xab);
    fakeTflite[0] = 0x18;
    fakeTflite[1] = 0x00;
    fakeTflite[4] = 0x54; // 'T'
    fakeTflite[5] = 0x46; // 'F'
    fakeTflite[6] = 0x4c; // 'L'
    fakeTflite[7] = 0x33; // '3'

    const zip = new JSZip();
    zip.file('trained.tflite', fakeTflite);
    const zipBytes = await zip.generateAsync({ type: 'arraybuffer' });

    const out = await extractTFLiteFromDeploymentZip(zipBytes);
    expect(out.length).toBe(64);
    expect(out[4]).toBe(0x54);
  });

  it('falls back to parsing tflite-trained.h C-array when no raw .tflite', async () => {
    const fillerBytes = Array.from({ length: 32 }, (_, i) => `0x${(i & 0xff).toString(16).padStart(2, '0')}`)
      .join(', ');
    const headerSrc = `const unsigned char ei_tflite_trained_model[] = { ${fillerBytes} };`;
    const zip = new JSZip();
    zip.file('src/tflite-model/tflite-trained.h', headerSrc);
    const zipBytes = await zip.generateAsync({ type: 'arraybuffer' });

    const out = await extractTFLiteFromDeploymentZip(zipBytes);
    expect(out.length).toBeGreaterThanOrEqual(16);
    expect(out[0]).toBe(0x00);
    expect(out[16]).toBe(0x10);
  });

  it('errors clearly when neither path is available', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'no model here');
    const zipBytes = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(extractTFLiteFromDeploymentZip(zipBytes)).rejects.toThrow(
      /No raw .tflite or tflite-trained/,
    );
  });
});
