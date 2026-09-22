import ExcelJS from 'exceljs';
import { WORKBOOK_LIMITS, WorkbookImportError } from '../xlsx/workbook-policy.js';
import { preflightWorkbook } from '../xlsx/workbook-reader.js';

export interface SourceCell {
  rawValue: unknown;
  displayedText: string;
  numberFormat: string | null;
  location: string;
  /** 1 起始的真实列号（xlsx 由 cell.col/address 得出，csv 即物理列序）。 */
  column: number;
}

export interface TableDataRow {
  /** 工作表中的真实行号（1 起始，含表头行计数），与单元格 location 一致。 */
  rowNumber: number;
  cells: SourceCell[];
}

export interface TableSheet {
  name: string;
  rowCount: number;
  rows: TableDataRow[];
}

export interface TableDocument {
  fileName: string;
  sheets: TableSheet[];
}

export function isXlsxName(name: string): boolean {
  return name.toLowerCase().endsWith('.xlsx');
}

export function isCsvName(name: string): boolean {
  return name.toLowerCase().endsWith('.csv');
}

// XLSX：复用专用导入器的全部安全检查（压缩大小/ZIP 条目/展开量/宏/外部链接/公式/单元格数）。
export async function readXlsxTable(fileName: string, bytes: Uint8Array): Promise<TableDocument> {
  const deadline = Date.now() + WORKBOOK_LIMITS.timeoutMs;
  await preflightWorkbook(bytes, deadline);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  } catch {
    throw new WorkbookImportError('invalid_xlsx', '文件不是有效的 XLSX 工作簿。');
  }
  if (workbook.worksheets.length > WORKBOOK_LIMITS.sheets) {
    throw new WorkbookImportError('sheet_limit', `工作簿超过 ${WORKBOOK_LIMITS.sheets} 个工作表。`);
  }
  const sheets: TableSheet[] = [];
  for (const worksheet of workbook.worksheets) {
    let nonEmpty = 0;
    const rowByNumber = new Map<number, SourceCell[]>();
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (Date.now() > deadline) throw new WorkbookImportError('timeout', '工作簿解析超时。');
        nonEmpty += 1;
        if (nonEmpty > WORKBOOK_LIMITS.nonEmptyCellsPerSheet) {
          throw new WorkbookImportError('cell_limit', `工作表“${worksheet.name}”非空单元格超过安全限制。`);
        }
        if (Buffer.byteLength(cell.text, 'utf8') > WORKBOOK_LIMITS.stringBytes) {
          throw new WorkbookImportError('string_limit', `工作表“${worksheet.name}”含超长文本。`);
        }
        if (cell.type === ExcelJS.ValueType.Formula) {
          throw new WorkbookImportError('formula_rejected', `表格 ${worksheet.name}!${cell.address} 含公式，已拒绝导入。`);
        }
        // 按真实列号落位（稀疏数组）：中间的空单元格不能让后续列左移。
        // exceljs 的 cell.col 在部分联合类型下是可选字段，从 address 兜底解析列号。
        const fromAddress = cell.address.match(/^([A-Z]+)(\d+)$/i)?.[1];
        const columnFromAddress = (fromAddress ?? '').split('').reduce((acc, ch) => acc * 26 + (ch.toUpperCase().charCodeAt(0) - 64), 0);
        const column = typeof cell.col === 'number' ? cell.col : columnFromAddress;
        const cells = rowByNumber.get(rowNumber) ?? [];
        cells[column - 1] = {
          rawValue: cell.value,
          displayedText: cell.text,
          numberFormat: cell.numFmt || null,
          location: `${worksheet.name}!${cell.address}`,
          column,
        };
        rowByNumber.set(rowNumber, cells);
      });
    });
    const rows = [...rowByNumber.entries()]
      .sort(([left], [right]) => left - right)
      .map(([rowNumber, cells]) => ({ rowNumber, cells }));
    sheets.push({ name: worksheet.name, rowCount: worksheet.rowCount, rows });
  }
  return { fileName, sheets };
}

// CSV：RFC4180（逗号/双引号/引号转义/CRLF）；所有单元格按纯文本处理，绝不执行其中内容。
// 编码：优先 UTF-8（fatal 校验），失败回退 GB18030（中文 Excel 默认导出编码），避免静默乱码入库。
export function readCsvTable(fileName: string, bytes: Uint8Array): TableDocument {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('gb18030').decode(bytes);
    } catch {
      throw new WorkbookImportError('charset_invalid', 'CSV 编码无法识别，请另存为 UTF-8 后重试。');
    }
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  const deadline = Date.now() + WORKBOOK_LIMITS.timeoutMs;
  const maxRows = Math.floor(WORKBOOK_LIMITS.nonEmptyCellsPerSheet / 8);
  const rows: TableDataRow[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let rowIndex = 0;

  const pushField = () => {
    if (Buffer.byteLength(field, 'utf8') > WORKBOOK_LIMITS.stringBytes) {
      throw new WorkbookImportError('string_limit', 'CSV 含超过 64KB 的字段，已拒绝导入。');
    }
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    const hasContent = row.length > 1 || (row[0] ?? '').trim() !== '';
    if (hasContent) {
      rowIndex += 1;
      rows.push({
        rowNumber: rowIndex,
        cells: row.map((value, columnIndex) => ({
          rawValue: value,
          displayedText: value,
          numberFormat: null,
          location: `${fileName}#${rowIndex}C${columnIndex + 1}`,
          column: columnIndex + 1,
        })),
      });
    }
    row = [];
    if (rows.length > maxRows) throw new WorkbookImportError('cell_limit', 'CSV 行数超过安全限制。');
  };

  for (let index = 0; index < text.length; index += 1) {
    if ((index & 0xFFF) === 0 && Date.now() > deadline) {
      throw new WorkbookImportError('timeout', 'CSV 解析超时，已停止。');
    }
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else inQuotes = false;
      } else field += character;
      continue;
    }
    if (character === '"') inQuotes = true;
    else if (character === ',') pushField();
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else field += character;
  }
  if (field !== '' || row.length > 0) pushRow();

  return {
    fileName,
    sheets: [{ name: fileName, rowCount: rows.length, rows }],
  };
}

export function readTable(fileName: string, bytes: Uint8Array): Promise<TableDocument> {
  if (isXlsxName(fileName)) return readXlsxTable(fileName, bytes);
  if (isCsvName(fileName)) return Promise.resolve(readCsvTable(fileName, bytes));
  return Promise.reject(new WorkbookImportError('unsupported_type', '只接受 .xlsx 或 .csv 文件。'));
}
