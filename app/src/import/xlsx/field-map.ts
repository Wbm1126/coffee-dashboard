export const COMPLETE_SHEET = '产品详情对比';
export const SELECTION_SHEET = '选豆决策表';

export interface SourceCell<T = unknown> {
  rawValue: T;
  displayedText: string;
  numberFormat: string | null;
  location: string;
}

export interface CompleteWorkbookRow {
  rowNumber: number;
  brand: SourceCell;
  name: SourceCell;
  roastLevel: SourceCell;
  overallScore: SourceCell;
  preferenceMatch: SourceCell;
  referencePrice: SourceCell;
  pricePerGram: SourceCell;
  specification: SourceCell;
  originOrVariety: SourceCell;
  process: SourceCell;
  officialFlavorDescription: SourceCell;
  americanoPerformance: SourceCell;
  milkPerformance: SourceCell;
  suitableScenes: SourceCell;
  note: SourceCell;
}

export interface SelectionWorkbookRow {
  rowNumber: number;
  recommendation: SourceCell;
  brand: SourceCell;
  name: SourceCell;
  roastLevel: SourceCell;
  pricePerGram: SourceCell;
  specification: SourceCell;
  originOrVariety: SourceCell;
  process: SourceCell;
  flavorKeywords: SourceCell;
  suitableScenes: SourceCell;
  status: SourceCell;
  personalScore: SourceCell;
  scoreBasis: SourceCell;
}

export interface WorkbookRows {
  complete: CompleteWorkbookRow[];
  selection: SelectionWorkbookRow[];
  fileHashes: { complete: string; selection: string };
  fileNames: { complete: string; selection: string };
}
