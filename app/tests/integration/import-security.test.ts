import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';
import { createImportPreview } from '../../src/import/xlsx/preview-service.js';
import { buildRepresentativeWorkbooks } from '../fixtures/import/build-workbooks.js';

async function mutateZip(bytes: Uint8Array, mutate: (zip: JSZip) => void | Promise<void>) {
  const zip = await JSZip.loadAsync(bytes);
  await mutate(zip);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

function inflateDeclaredSize(bytes: Uint8Array): Buffer {
  const result = Buffer.from(bytes);
  for (let offset = 0; offset < result.length - 46; offset += 1) {
    if (result.readUInt32LE(offset) === 0x02014b50) {
      result.writeUInt32LE(101 * 1024 * 1024, offset + 24);
      return result;
    }
  }
  throw new Error('central directory not found');
}

describe('workbook import security limits', () => {
  it('requires both supported workbooks', async () => {
    const files = await buildRepresentativeWorkbooks();
    await expect(createImportPreview({ complete: files.complete, selection: null, existing: createEmptyCoffeeData() })).rejects.toThrow(/两份|选单/);
  });

  it('rejects formulas in the main data sheet', async () => {
    const files = await buildRepresentativeWorkbooks({ formula: true });
    await expect(createImportPreview({ ...files, existing: createEmptyCoffeeData() })).rejects.toThrow(/公式/);
  });

  it('rejects compressed uploads and schema-invalid rows before preview', async () => {
    const files = await buildRepresentativeWorkbooks();
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    await expect(createImportPreview({ complete: { name: '过大.xlsx', bytes: oversized }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/25MB/);
    const invalid = await buildRepresentativeWorkbooks({ invalidFieldLength: true });
    await expect(createImportPreview({ ...invalid, existing: createEmptyCoffeeData() })).rejects.toThrow(/字段|范围/);
  });

  it('rejects macros and external links before workbook parsing', async () => {
    const files = await buildRepresentativeWorkbooks();
    const macro = await mutateZip(files.complete.bytes, (zip) => { zip.file('xl/vbaProject.bin', 'macro'); });
    await expect(createImportPreview({ complete: { name: '宏.xlsx', bytes: macro }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/宏/);
    const external = await mutateZip(files.complete.bytes, (zip) => { zip.file('xl/externalLinks/externalLink1.xml', '<externalLink/>'); });
    await expect(createImportPreview({ complete: { name: '外链.xlsx', bytes: external }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/外部链接/);
  });

  it('rejects oversized dimensions, strings, sheet counts and expanded-size declarations', async () => {
    const files = await buildRepresentativeWorkbooks();
    const dimension = await mutateZip(files.complete.bytes, async (zip) => {
      const entry = zip.file('xl/worksheets/sheet1.xml');
      if (!entry) throw new Error('sheet xml missing');
      const xml = await entry.async('string');
      zip.file('xl/worksheets/sheet1.xml', xml.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:XFD1048576"/>'));
    });
    await expect(createImportPreview({ complete: { name: '超范围.xlsx', bytes: dimension }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/范围|限制/);

    const long = await buildRepresentativeWorkbooks({ longString: true });
    await expect(createImportPreview({ ...long, existing: createEmptyCoffeeData() })).rejects.toThrow(/64KB/);

    const manySheets = await buildRepresentativeWorkbooks({ sheetCount: 21 });
    await expect(createImportPreview({ ...manySheets, existing: createEmptyCoffeeData() })).rejects.toThrow(/20/);

    const bomb = inflateDeclaredSize(files.complete.bytes);
    await expect(createImportPreview({ complete: { name: '膨胀.xlsx', bytes: bomb }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/100MB/);
  });

  it('rejects archives with more than 100 ZIP entries', async () => {
    const files = await buildRepresentativeWorkbooks();
    const crowded = await mutateZip(files.complete.bytes, (zip) => {
      for (let index = 0; index < 101; index += 1) zip.file(`extra/${index}.txt`, '');
    });
    await expect(createImportPreview({ complete: { name: '条目过多.xlsx', bytes: crowded }, selection: files.selection, existing: createEmptyCoffeeData() })).rejects.toThrow(/100/);
  });
});
