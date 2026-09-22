import ExcelJS, { type Cell } from 'exceljs';
import { WORKBOOK_LIMITS, WorkbookImportError } from '../xlsx/workbook-policy.js';

export interface SourceCell {
  rawValue: unknown;
  displayedText: string;
  numberFormat: string | null;
  location: string;
}

export interface TableSheet {
  name: string;
  rowCount: number;
  rows: SourceCell[][];
}

export interface TableDocument {
  fileName: string;
  sheets: TableSheet[];
}

function sourceCell(cell: Cell): SourceCell {
  return {
    rawValue: cell.value,
    displayedText: cell.text,
    numberFormat: cell.numFmt || null,
    location: `${cell.worksheet.name}!${cell.address}`,
  };
}

export function isXlsxName(name: string): boolean {
  return name.toLowerCase().endsWith('.xlsx');
}

export function isCsvName(name: string): boolean {
  return name.toLowerCase().endsWith('.csv');
}

// XLSX：沿用专用导入器的安全限制（大小/宏/公式/单元格数），但读取全部工作表为通用表格。
export async function readXlsxTable(fileName: string, bytes: Uint8Array): Promise<TableDocument> {
  const deadline = Date.now() + WORKBOOK_LIMITS.timeoutMs;
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
    const rows: SourceCell[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: SourceCell[] = [];
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
        cells[column - 1] = sourceCell(cell);
      });
      if (cells.length > 0) rows[rowNumber - 1] = cells;
    });
    // 去掉整行皆空的占位行；行内保留稀疏空洞（访问为 undefined，视为空单元格）。
    sheets.push({ name: worksheet.name, rowCount: worksheet.rowCount, rows: rows.filter((cells) => Array.isArray(cells)) });
  }
  return { fileName, sheets };
}

// CSV：RFC4180（逗号/双引号/引号转义/CRLF），BOM 剥离；所有单元格按纯文本处理，绝不执行其中内容。
export function readCsvTable(fileName: string, bytes: Uint8Array): TableDocument {
  let text = Buffer.from(bytes).toString('utf8');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0]!.trim() !== '') rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
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
  if (rows.length > WORKBOOK_LIMITS.nonEmptyCellsPerSheet / 8) {
    throw new WorkbookImportError('cell_limit', 'CSV 行数超过安全限制。');
  }
  const cells: SourceCell[][] = rows.map((values, rowIndex) =>
    values.map((value, columnIndex) => ({
      rawValue: value,
      displayedText: value,
      numberFormat: null,
      location: `${fileName}#${rowIndex + 1}C${columnIndex + 1}`,
    })),
  );
  return {
    fileName,
    sheets: [{ name: fileName, rowCount: cells.length, rows: cells }],
  };
}

export function readTable(fileName: string, bytes: Uint8Array): Promise<TableDocument> {
  if (isXlsxName(fileName)) return readXlsxTable(fileName, bytes);
  if (isCsvName(fileName)) return Promise.resolve(readCsvTable(fileName, bytes));
  return Promise.reject(new WorkbookImportError('unsupported_type', '只接受 .xlsx 或 .csv 文件。'));
}
