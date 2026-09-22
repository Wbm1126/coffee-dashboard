import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDataDir } from '../../src/server/data-dir.js';

describe('数据目录解析（环境变量分支）', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'coffee-data-dir-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('环境变量指向已存在目录时优先生效', async () => {
    vi.stubEnv('COFFEE_DASHBOARD_DATA_DIR', dataRoot);
    const resolution = await resolveDataDir();
    expect(resolution.dataDir).toBe(resolve(dataRoot));
    expect(resolution.source).toBe('环境变量 COFFEE_DASHBOARD_DATA_DIR');
  });

  it('环境变量包含 .. 段时直接拒绝，不做路径解析', async () => {
    // 手工拼接保留字面 ..，path.join 会把 .. 规范化掉而测不到校验。
    vi.stubEnv('COFFEE_DASHBOARD_DATA_DIR', [dataRoot, '..', 'escape'].join(sep));
    await expect(resolveDataDir()).rejects.toThrow('不允许包含 .. 段');
  });

  it('环境变量指向不存在的目录时报错而非静默回退', async () => {
    vi.stubEnv('COFFEE_DASHBOARD_DATA_DIR', join(dataRoot, 'not-created'));
    await expect(resolveDataDir()).rejects.toThrow('目录不存在');
  });
});
