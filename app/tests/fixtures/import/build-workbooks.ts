import ExcelJS from 'exceljs';

const completeHeaders = ['品牌', '产品名称', '烘焙度', '综合评分', '偏好匹配', '参考价格¥', '元/克', '规格g', '产地/豆种', '处理法', '官方风味描述', '美式表现', '奶咖表现', '适合场景', '你的备注'];
const selectionHeaders = ['推荐', '品牌', '产品', '烘焙度', '元/克', '规格', '产地/豆种', '处理法', '风味关键词', '适合场景', '状态', '个人评分', '打分依据'];

async function bytes(workbook: ExcelJS.Workbook) {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildRepresentativeWorkbooks(options: { formula?: boolean; longString?: boolean; invalidFieldLength?: boolean; sheetCount?: number; duplicateComplete?: boolean; blankProcess?: boolean } = {}) {
  const complete = new ExcelJS.Workbook();
  const completeSheet = complete.addWorksheet('产品详情对比');
  completeSheet.addRow(completeHeaders);
  completeSheet.addRow([
    '示例烘焙', '晨光', '中烘焙', 4.5, '高', 157, 0.6899999999999999, 227,
    '埃塞俄比亚', options.blankProcess ? '' : '水洗', options.longString ? '花'.repeat(70 * 1024) : options.invalidFieldLength ? '花'.repeat(4_001) : '柑橘\n白花',
    '清爽', '柔和', '美式、奶咖', '',
  ]);
  completeSheet.addRow(['示例烘焙', '夜航', '深烘焙', 4.1, '中', 120, 0.53, 227, '巴西', '日晒', '坚果', '厚实', '巧克力', '奶咖', '']);
  if (options.duplicateComplete) completeSheet.addRow(['示例烘焙', '晨光', '中烘焙', 4.5, '高', 157, 0.69, 227, '埃塞俄比亚', '水洗', '重复行', '清爽', '柔和', '美式', '']);
  if (options.formula) completeSheet.getCell('F2').value = { formula: '1+1', result: 2 };
  const totalSheets = options.sheetCount ?? 1;
  for (let index = 1; index < totalSheets; index += 1) complete.addWorksheet(`附表${index}`);

  const selection = new ExcelJS.Workbook();
  const selectionSheet = selection.addWorksheet('选豆决策表');
  selectionSheet.addRow(selectionHeaders);
  selectionSheet.addRow(['⭐', '示例烘焙', '晨光', '中浅烘焙', 0.69, '227g', '埃塞俄比亚', options.blankProcess ? '' : '水洗', '柑橘、白花', '美式、奶咖', '🆕未喝', '', '']);
  selectionSheet.addRow(['', '示例烘焙', '夜航', '深度烘焙', 0.53, '227g', '巴西', '日晒', '坚果', '奶咖', '✅已喝', 'A-', '顺滑']);
  selection.addWorksheet('购买计划').addRow(['品牌', '产品']);

  return {
    complete: { name: '完整版.xlsx', bytes: await bytes(complete) },
    selection: { name: '选单.xlsx', bytes: await bytes(selection) },
  };
}
