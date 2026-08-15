import { Worker } from 'node:worker_threads';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import {
  type CompleteWorkbookRow,
  type SelectionWorkbookRow,
  type WorkbookRows,
} from './field-map.js';
import { WORKBOOK_LIMITS, WorkbookImportError } from './workbook-policy.js';
import { sha256 } from '../../lib/sha256.js';

export { WORKBOOK_LIMITS, WorkbookImportError } from './workbook-policy.js';

export interface WorkbookUpload {
  name: string;
  bytes: Uint8Array;
}

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(new WorkbookImportError('invalid_zip', '文件不是有效的 XLSX 工作簿。'));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error('无法读取 ZIP 条目。'));
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length <= limit) chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function dimensionCellCount(reference: string): number {
  const end = reference.split(':').at(-1) ?? 'A1';
  const match = end.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return 0;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return column * Number(match[2]);
}

async function preflight(bytes: Uint8Array, deadline: number): Promise<void> {
  if (bytes.byteLength > WORKBOOK_LIMITS.compressedBytes) {
    throw new WorkbookImportError('compressed_limit', '工作簿超过 25MB 压缩大小限制。');
  }
  const zip = await openZip(bytes);
  let entries = 0;
  let expanded = 0;
  let worksheets = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (Date.now() > deadline) throw new WorkbookImportError('timeout', '工作簿安全检查超时。');
        entries += 1;
        expanded += entry.uncompressedSize;
        if (entries > WORKBOOK_LIMITS.zipEntries) throw new WorkbookImportError('entry_limit', '工作簿 ZIP 条目超过 100 个。');
        if (expanded > WORKBOOK_LIMITS.expandedBytes) throw new WorkbookImportError('expanded_limit', '工作簿展开后超过 100MB。');
        const name = entry.fileName.replace(/\\/g, '/');
        if (/vbaProject\.bin$/i.test(name) || /xl\/macrosheets\//i.test(name)) {
          throw new WorkbookImportError('macro_rejected', '不接受包含宏的工作簿。');
        }
        if (/^xl\/externalLinks\//i.test(name)) {
          throw new WorkbookImportError('external_link_rejected', '不接受包含外部链接的工作簿。');
        }
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
          worksheets += 1;
          if (worksheets > WORKBOOK_LIMITS.sheets) throw new WorkbookImportError('sheet_limit', '工作簿超过 20 个工作表。');
          const xml = await readEntry(zip, entry, 256 * 1024);
          const dimension = xml.match(/<dimension[^>]+ref="([^"]+)"/i)?.[1];
          if (dimension && dimensionCellCount(dimension) > WORKBOOK_LIMITS.nonEmptyCellsPerSheet) {
            throw new WorkbookImportError('dimension_limit', '工作表声明的单元格范围超过安全限制。');
          }
        } else if (/\.rels$/i.test(name)) {
          if (entry.uncompressedSize > 1024 * 1024) {
            throw new WorkbookImportError('relationship_limit', '工作簿关系文件超过 1MB，无法安全检查外部链接。');
          }
          const xml = await readEntry(zip, entry, 1024 * 1024);
          if (/TargetMode="External"/i.test(xml)) {
            throw new WorkbookImportError('external_link_rejected', '不接受包含外部链接的工作簿。');
          }
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', resolve);
    zip.readEntry();
  });
}

interface WorkerSuccess<T> { ok: true; rows: T }
interface WorkerFailure { ok: false; code: string; message: string }

async function loadWorkbook<T extends CompleteWorkbookRow[] | SelectionWorkbookRow[]>(
  kind: 'complete' | 'selection',
  upload: WorkbookUpload,
  deadline: number,
): Promise<T> {
  await preflight(upload.bytes, deadline);
  const sourceMode = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(sourceMode ? './workbook-parser-worker.ts' : './workbook-parser-worker.js', import.meta.url);
  return new Promise<T>((resolve, reject) => {
    const workerTarget = sourceMode
      ? `void import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(import.meta.url)}));`
      : workerUrl;
    const worker = new Worker(workerTarget, {
      eval: sourceMode,
      workerData: { kind, bytes: upload.bytes, deadline },
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
    });
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new WorkbookImportError('timeout', '工作簿解析超过 15 秒，已停止。'));
    }, remaining);
    worker.once('message', (message: WorkerSuccess<T> | WorkerFailure) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok) resolve(message.rows);
      else reject(new WorkbookImportError(message.code, message.message));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(new WorkbookImportError('parse_failed', `工作簿解析进程失败：${error.message}`));
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new WorkbookImportError('parse_failed', '工作簿解析进程异常退出。'));
      }
    });
  });
}

export async function readImportWorkbooks(complete: WorkbookUpload | null, selection: WorkbookUpload | null): Promise<WorkbookRows> {
  if (!complete || !selection) throw new WorkbookImportError('workbook_missing', '必须同时选择完整版和选单两份工作簿。');
  const deadline = Date.now() + WORKBOOK_LIMITS.timeoutMs;
  const [completeRows, selectionRows] = await Promise.all([
    loadWorkbook<CompleteWorkbookRow[]>('complete', complete, deadline),
    loadWorkbook<SelectionWorkbookRow[]>('selection', selection, deadline),
  ]);
  return {
    complete: completeRows,
    selection: selectionRows,
    fileHashes: { complete: sha256(complete.bytes), selection: sha256(selection.bytes) },
    fileNames: { complete: complete.name, selection: selection.name },
  };
}
