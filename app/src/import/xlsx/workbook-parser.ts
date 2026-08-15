import ExcelJS, { type Cell, type Worksheet } from 'exceljs';
import { COMPLETE_SHEET, SELECTION_SHEET, type CompleteWorkbookRow, type SelectionWorkbookRow, type SourceCell } from './field-map.js';
import { WORKBOOK_LIMITS, WorkbookImportError } from './workbook-policy.js';

function sourceCell(cell: Cell): SourceCell {
  return {
    rawValue: cell.value,
    displayedText: cell.text,
    numberFormat: cell.numFmt || null,
    location: `${cell.worksheet.name}!${cell.address}`,
  };
}

function validateWorksheet(worksheet: Worksheet, deadline: number): void {
  let nonEmpty = 0;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (Date.now() > deadline) throw new WorkbookImportError('timeout', '工作簿解析超时。');
      nonEmpty += 1;
      if (nonEmpty > WORKBOOK_LIMITS.nonEmptyCellsPerSheet) {
        throw new WorkbookImportError('cell_limit', `工作表“${worksheet.name}”非空单元格超过 100000 个。`);
      }
      if (Buffer.byteLength(cell.text, 'utf8') > WORKBOOK_LIMITS.stringBytes) {
        throw new WorkbookImportError('string_limit', `工作表“${worksheet.name}”含超过 64KB 的文本。`);
      }
    });
  });
}

function rejectFormulas(worksheet: Worksheet): void {
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) {
        throw new WorkbookImportError('formula_rejected', `主数据表 ${worksheet.name}!${cell.address} 含公式，已拒绝导入。`);
      }
    });
  });
}

function assertHeaders(worksheet: Worksheet, expected: string[]): void {
  const actual = expected.map((_header, index) => worksheet.getCell(1, index + 1).text.trim());
  if (actual.some((header, index) => header !== expected[index])) {
    throw new WorkbookImportError('headers_invalid', `工作表“${worksheet.name}”的列标题与支持的模板不一致。`);
  }
}

function completeRows(worksheet: Worksheet): CompleteWorkbookRow[] {
  assertHeaders(worksheet, ['品牌', '产品名称', '烘焙度', '综合评分', '偏好匹配', '参考价格¥', '元/克', '规格g', '产地/豆种', '处理法', '官方风味描述', '美式表现', '奶咖表现', '适合场景', '你的备注']);
  rejectFormulas(worksheet);
  const rows: CompleteWorkbookRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || (!row.getCell(1).text.trim() && !row.getCell(2).text.trim())) return;
    const c = (column: number) => sourceCell(row.getCell(column));
    rows.push({ rowNumber, brand: c(1), name: c(2), roastLevel: c(3), overallScore: c(4), preferenceMatch: c(5), referencePrice: c(6), pricePerGram: c(7), specification: c(8), originOrVariety: c(9), process: c(10), officialFlavorDescription: c(11), americanoPerformance: c(12), milkPerformance: c(13), suitableScenes: c(14), note: c(15) });
  });
  return rows;
}

function selectionRows(worksheet: Worksheet): SelectionWorkbookRow[] {
  assertHeaders(worksheet, ['推荐', '品牌', '产品', '烘焙度', '元/克', '规格', '产地/豆种', '处理法', '风味关键词', '适合场景', '状态', '个人评分', '打分依据']);
  rejectFormulas(worksheet);
  const rows: SelectionWorkbookRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || (!row.getCell(2).text.trim() && !row.getCell(3).text.trim())) return;
    const c = (column: number) => sourceCell(row.getCell(column));
    rows.push({ rowNumber, recommendation: c(1), brand: c(2), name: c(3), roastLevel: c(4), pricePerGram: c(5), specification: c(6), originOrVariety: c(7), process: c(8), flavorKeywords: c(9), suitableScenes: c(10), status: c(11), personalScore: c(12), scoreBasis: c(13) });
  });
  return rows;
}

export async function parseWorkbook(kind: 'complete' | 'selection', bytes: Uint8Array, deadline: number) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  if (workbook.worksheets.length > WORKBOOK_LIMITS.sheets) throw new WorkbookImportError('sheet_limit', '工作簿超过 20 个工作表。');
  workbook.eachSheet((worksheet) => validateWorksheet(worksheet, deadline));
  const sheetName = kind === 'complete' ? COMPLETE_SHEET : SELECTION_SHEET;
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new WorkbookImportError('main_sheet_missing', `找不到“${sheetName}”主数据表。`);
  return kind === 'complete' ? completeRows(worksheet) : selectionRows(worksheet);
}
