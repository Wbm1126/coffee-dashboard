import { normalizeBeanIdentity } from '../../domain/bean-identity.js';

// 通用表格导入的规范字段：一张表按表头映射到这些字段后即可参与导入。
// 身份字段（brand/beanName）必须映射成功，其余字段按可得性导入。
export const TABLE_FIELDS = [
  'brand',
  'beanName',
  'roastLevel',
  'process',
  'originOrVariety',
  'specification',
  'referencePrice',
  'pricePerGram',
  'officialFlavorDescription',
  'americanoPerformance',
  'milkPerformance',
  'suitableScenes',
  'flavorKeywords',
  'recommendation',
  'status',
  'personalScore',
  'scoreBasis',
  'overallScore',
  'preferenceMatch',
  'note',
] as const;

export type TableField = (typeof TABLE_FIELDS)[number];

export const TABLE_FIELD_LABELS: Record<TableField, string> = {
  brand: '品牌',
  beanName: '豆名',
  roastLevel: '烘焙度',
  process: '处理法',
  originOrVariety: '产地/豆种',
  specification: '规格',
  referencePrice: '参考价格',
  pricePerGram: '元/克',
  officialFlavorDescription: '官方风味描述',
  americanoPerformance: '美式表现',
  milkPerformance: '奶咖表现',
  suitableScenes: '适合场景',
  flavorKeywords: '风味关键词',
  recommendation: '推荐等级',
  status: '状态',
  personalScore: '个人评分',
  scoreBasis: '打分依据',
  overallScore: '综合评分',
  preferenceMatch: '偏好匹配',
  note: '备注',
};

// 同义词词典：表头（经 normalizeBeanIdentity 归一）→ 规范字段。
// 归一会小写化并去掉分隔符与空白，因此「产地/豆种」「产地／豆种」「产地豆种」等价。
const FIELD_SYNONYMS: Record<TableField, string[]> = {
  brand: ['品牌', 'brand', '牌子'],
  beanName: ['产品名称', '产品', '豆名', '咖啡豆', '名称', 'beanname', 'name'],
  roastLevel: ['烘焙度', '烘焙', 'roast'],
  process: ['处理法', '处理方式', '处理', '工艺'],
  originOrVariety: ['产地/豆种', '产地', '豆种'],
  specification: ['规格g', '规格'],
  referencePrice: ['参考价格¥', '参考价格', '价格'],
  pricePerGram: ['元/克', '¥/克', '单价'],
  officialFlavorDescription: ['官方风味描述', '风味描述', '官方描述'],
  americanoPerformance: ['美式表现', '美式'],
  milkPerformance: ['奶咖表现', '奶咖'],
  suitableScenes: ['适合场景', '场景'],
  flavorKeywords: ['风味关键词', '风味'],
  recommendation: ['推荐', '推荐等级'],
  status: ['状态', '喝过状态'],
  personalScore: ['个人评分', '我的评分'],
  scoreBasis: ['打分依据', '评分依据'],
  overallScore: ['综合评分', '总评'],
  preferenceMatch: ['偏好匹配'],
  note: ['你的备注', '备注', 'note'],
};

const SYNONYM_INDEX = new Map<string, TableField>(
  Object.entries(FIELD_SYNONYMS).flatMap(([field, synonyms]) =>
    synonyms.map((synonym) => [normalizeBeanIdentity(synonym), field as TableField]),
  ),
);

export interface TableMapping {
  fields: Partial<Record<TableField, number>>;
  headers: string[];
  unmapped: string[];
}

// 为表头行给出自动映射提案：精确同义词命中优先，其次唯一包含关系；
// 一个表头只映射到一个字段，命中间数从 1 开始（0 号位是 ExcelJS 的占位）。
export function proposeMapping(headers: string[]): TableMapping {
  const fields: Partial<Record<TableField, number>> = {};
  const unmapped: string[] = [];
  const normalized = headers.map((header) => normalizeBeanIdentity(header));
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalized[index] ?? '';
    if (!header) continue;
    const exact = SYNONYM_INDEX.get(header);
    if (exact && !fields[exact]) {
      fields[exact] = index + 1;
      continue;
    }
    const contains = TABLE_FIELDS.filter((field) => !fields[field]).map((field) => ({
      field,
      synonym: (FIELD_SYNONYMS[field] ?? [])
        .map((synonym) => normalizeBeanIdentity(synonym))
        .filter((synonym) => synonym.length > 1 && (header.includes(synonym) || synonym.includes(header)))
        .sort((left, right) => right.length - left.length)[0],
    }))
      .filter((hit): hit is { field: TableField; synonym: string } => Boolean(hit.synonym))
      .sort((left, right) => right.synonym.length - left.synonym.length)[0];
    if (contains) fields[contains.field] = index + 1;
    else unmapped.push(headers[index] ?? '');
  }
  return { fields, headers, unmapped };
}

// 应用用户修正：只接受 1..headers.length 的列号；身份字段缺失时抛错。
export function resolveMapping(headers: string[], override: Partial<Record<TableField, number | null>>): TableMapping {
  const proposed = proposeMapping(headers);
  const fields: Partial<Record<TableField, number>> = { ...proposed.fields };
  for (const [field, column] of Object.entries(override) as Array<[TableField, number | null]>) {
    if (column === null) {
      delete fields[field];
      continue;
    }
    if (!Number.isInteger(column) || (column as number) < 1 || (column as number) > headers.length) {
      throw new RangeError(`字段 ${field} 的列号 ${String(column)} 超出表头范围。`);
    }
    fields[field] = column as number;
  }
  // 两个字段不得映射到同一列：否则身份键退化（如 brand::brand），静默污染导入。
  const columnOwner = new Map<number, TableField>();
  for (const [field, column] of Object.entries(fields) as Array<[TableField, number]>) {
    const previous = columnOwner.get(column);
    if (previous) throw new RangeError(`字段 ${field} 与 ${previous} 映射到同一列 ${column}。`);
    columnOwner.set(column, field);
  }
  if (!fields.brand) throw new RangeError('缺少「品牌」列映射，无法导入。');
  if (!fields.beanName) throw new RangeError('缺少「豆名」列映射，无法导入。');
  const mappedColumns = new Set(Object.values(fields).map((column) => column as number));
  const unmapped = headers.filter((header, index) => !mappedColumns.has(index + 1) && normalizeBeanIdentity(header));
  return { fields, headers, unmapped };
}
