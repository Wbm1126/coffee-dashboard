// 一次性探针：读取两份真实 xlsx 的 sheet 结构与表头，为通用导入器的字段映射提供事实依据。用后即删。
import ExcelJS from 'exceljs';

const files = [
  'D:/obsidian-vault/30-私人内容/咖啡豆/意式咖啡豆_完整版.xlsx',
  'D:/obsidian-vault/30-私人内容/咖啡豆/意式咖啡豆_选单.xlsx',
];
for (const file of files) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  console.log(`\n### ${file.split('/').pop()} sheets=${wb.worksheets.length}`);
  for (const ws of wb.worksheets) {
    console.log(`-- [${ws.name}] rows=${ws.rowCount} cols=${ws.columnCount}`);
    const head = ws.getRow(1).values.slice(1).map((v) => String(v ?? ''));
    const row2 = ws.getRow(2).values.slice(1).map((v) => String(v ?? ''));
    console.log('   表头:', JSON.stringify(head));
    console.log('   首行:', JSON.stringify(row2.slice(0, 8)));
  }
}
