import { describe, expect, it } from 'vitest';
import {
  advancePurchaseDraft,
  commitSnapshotState,
  purchaseEditorKey,
  readSnapshotResponse,
} from '../../src/client/app-state.js';
import { createEmptyCoffeeData } from '../../src/domain/schema.js';

function readySnapshot(dataRevision: number) {
  const data = createEmptyCoffeeData(new Date('2026-08-07T08:00:00+08:00'));
  data.dataRevision = dataRevision;
  return { mode: 'ready' as const, data };
}

describe('App state transitions', () => {
  it('gives every accepted same-bean purchase draft a distinct editor key', () => {
    const initial = { beanId: null, nonce: 0 };
    const first = advancePurchaseDraft(initial, 'bean-1');
    const second = advancePurchaseDraft(first, 'bean-1');

    expect(first).toEqual({ beanId: 'bean-1', nonce: 1 });
    expect(second).toEqual({ beanId: 'bean-1', nonce: 2 });
    expect(purchaseEditorKey(null, second)).not.toBe(purchaseEditorKey(null, first));
  });

  it('keeps the latest ready snapshot when an older refresh resolves later', () => {
    const currentSnapshot = readySnapshot(4);
    const current = { mode: 'ready' as const, snapshot: currentSnapshot };

    expect(commitSnapshotState(current, readySnapshot(3))).toBe(current);
  });

  it('commits a newer snapshot and mode together', () => {
    const current = { mode: 'ready' as const, snapshot: readySnapshot(4) };
    const incoming = readySnapshot(5);

    expect(commitSnapshotState(current, incoming)).toEqual({ mode: 'ready', snapshot: incoming });
  });

  it('accepts a recovery payload returned with HTTP 503', async () => {
    const response = new Response(JSON.stringify({ mode: 'recovery', reason: 'damaged', backups: [] }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readSnapshotResponse(response)).resolves.toMatchObject({ mode: 'recovery', reason: 'damaged' });
  });

  it('rejects an error response that pretends data is ready', async () => {
    const response = new Response(JSON.stringify(readySnapshot(4)), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readSnapshotResponse(response)).rejects.toThrow('暂时无法读取本地数据概览');
  });
});
