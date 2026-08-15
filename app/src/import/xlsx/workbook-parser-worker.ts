import { parentPort, workerData } from 'node:worker_threads';
import { parseWorkbook } from './workbook-parser.js';

interface ParserWorkerData {
  kind: 'complete' | 'selection';
  bytes: Uint8Array;
  deadline: number;
}

const input = workerData as ParserWorkerData;

try {
  const rows = await parseWorkbook(input.kind, input.bytes, input.deadline);
  parentPort?.postMessage({ ok: true, rows });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'parse_failed',
    message: error instanceof Error ? error.message : '工作簿解析失败。',
  });
}
