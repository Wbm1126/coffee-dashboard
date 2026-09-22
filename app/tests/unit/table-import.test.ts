import { describe, expect, it } from 'vitest';
import { proposeMapping, resolveMapping, TABLE_FIELD_LABELS } from '../../src/import/table/field-map.js';
import { readCsvTable } from '../../src/import/table/table-document.js';

describe('通用表格字段映射', () => {
  it('按同义词自动映射真实工作簿表头（完整版与选单）', () => {
    const complete = proposeMapping(['品牌', '产品名称', '烘焙度', '综合评分', '偏好匹配', '参考价格¥', '元/克', '规格g', '产地/豆种', '处理法', '官方风味描述', '美式表现', '奶咖表现', '适合场景', '你的备注']);
    expect(complete.fields.brand).toBe(1);
    expect(complete.fields.beanName).toBe(2);
    expect(complete.fields.roastLevel).toBe(3);
    expect(complete.fields.overallScore).toBe(4);
    expect(complete.fields.referencePrice).toBe(6);
    expect(complete.fields.pricePerGram).toBe(7);
    expect(complete.fields.specification).toBe(8);
    expect(complete.fields.originOrVariety).toBe(9);
    expect(complete.fields.officialFlavorDescription).toBe(11);
    expect(complete.fields.americanoPerformance).toBe(12);
    expect(complete.fields.suitableScenes).toBe(14);
    expect(complete.fields.note).toBe(15);
    expect(complete.unmapped).toEqual([]);

    const selection = proposeMapping(['推荐', '品牌', '产品', '烘焙度', '元/克', '规格', '产地/豆种', '处理法', '风味关键词', '适合场景', '状态', '个人评分', '打分依据']);
    expect(selection.fields.recommendation).toBe(1);
    expect(selection.fields.beanName).toBe(3);
    expect(selection.fields.personalScore).toBe(12);
    expect(selection.fields.scoreBasis).toBe(13);
    expect(selection.unmapped).toEqual([]);
  });

  it('身份字段缺失或列号越界时拒绝映射', () => {
    expect(() => resolveMapping(['名称', '备注'], {})).toThrow(/品牌/);
    expect(() => resolveMapping(['品牌'], {})).toThrow(/豆名/);
    expect(() => resolveMapping(['品牌', '产品'], { brand: 99 })).toThrow(/超出表头范围/);
    expect(resolveMapping(['品牌', '产品'], { note: null }).fields.note).toBeUndefined();
  });

  it('所有规范字段都有中文标签', () => {
    for (const field of Object.keys(TABLE_FIELD_LABELS)) {
      expect(TABLE_FIELD_LABELS[field as keyof typeof TABLE_FIELD_LABELS]).toBeTruthy();
    }
  });
});

describe('CSV 表格读取', () => {
  it('解析引号、逗号、引号转义与 CRLF，并剥离 BOM', () => {
    const csv = '\uFEFF品牌,产品,备注\n"铁壶","黑猫","含,逗号"\r\n铁壶,疣猪,"含""引号"""';
    const document = readCsvTable('beans.csv', new TextEncoder().encode(csv));
    expect(document.sheets).toHaveLength(1);
    const rows = document.sheets[0]!.rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.map((cell) => cell.displayedText)).toEqual(['品牌', '产品', '备注']);
    expect(rows[1]![2]!.displayedText).toBe('含,逗号');
    expect(rows[2]![2]!.displayedText).toBe('含"引号"');
    expect(rows[1]![0]!.location).toBe('beans.csv#2C1');
  });

  it('空行不产生数据行', () => {
    const document = readCsvTable('beans.csv', new TextEncoder().encode('品牌,产品\n\n铁壶,黑猫\n'));
    expect(document.sheets[0]!.rows).toHaveLength(2);
  });
});
