// 饮用记录的时序与配方判定共享工具：排序与"是否有配方"的定义只在这里维护一份。
import type { CoffeeData } from '../../../domain/schema.js';

export type DrinkRecord = CoffeeData['drinkingRecords'][number];

// drankOn 是定宽日期前缀，createdAt 作并列时的次序依据。
export function compareByRecency(left: DrinkRecord, right: DrinkRecord): number {
  return right.drankOn.localeCompare(left.drankOn) || right.createdAt.localeCompare(left.createdAt);
}

export function sortedByRecency(records: DrinkRecord[]): DrinkRecord[] {
  return [...records].sort(compareByRecency);
}

// 全空参数不算"有配方"：编辑器总是提交完整对象，全空记录不应遮蔽更早的真实配方。
export function hasBrewParams(params: DrinkRecord['brewParams']): params is NonNullable<DrinkRecord['brewParams']> {
  return !!params && Object.values(params).some((value) => value !== null);
}

export function latestBrewRecipe(records: DrinkRecord[]): DrinkRecord | null {
  return sortedByRecency(records.filter((record) => !record.deletedAt && hasBrewParams(record.brewParams)))[0] ?? null;
}
