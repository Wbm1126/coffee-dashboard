import type { CoffeeData } from '../domain/schema';

export type AppMode = 'loading' | 'ready' | 'read_only' | 'recovery' | 'error';

export interface SnapshotResponse {
  mode: 'ready' | 'read_only' | 'recovery';
  data?: CoffeeData;
  reason?: string;
}

export type EditingRecord =
  | { kind: 'purchase'; id: string }
  | { kind: 'drinking'; id: string }
  | null;

export interface AppState {
  mode: AppMode;
  snapshot: SnapshotResponse | null;
}

export interface PurchaseDraft {
  beanId: string | null;
  nonce: number;
}

const isSnapshotResponse = (value: unknown): value is SnapshotResponse => {
  if (typeof value !== 'object' || value === null || !('mode' in value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === 'ready' || mode === 'read_only' || mode === 'recovery';
};

export async function readSnapshotResponse(response: Response): Promise<SnapshotResponse> {
  const body: unknown = await response.json();
  if (!isSnapshotResponse(body)) throw new Error('本地数据概览响应无效。');
  if (!response.ok && body.mode === 'ready') throw new Error('暂时无法读取本地数据概览。');
  return body;
}

export const advancePurchaseDraft = (current: PurchaseDraft, beanId: string): PurchaseDraft => ({
  beanId,
  nonce: current.nonce + 1,
});

export const purchaseEditorKey = (editingRecord: EditingRecord, draft: PurchaseDraft): string => editingRecord?.kind === 'purchase'
  ? editingRecord.id
  : `new-purchase-${draft.beanId ?? 'default'}-${draft.nonce}`;

export const commitSnapshotState = (current: AppState, incoming: SnapshotResponse): AppState => {
  const currentRevision = current.mode === 'ready' ? current.snapshot?.data?.dataRevision : undefined;
  const incomingRevision = incoming.data?.dataRevision;
  if (currentRevision !== undefined && incomingRevision !== undefined && incomingRevision < currentRevision) return current;
  return { mode: incoming.mode === 'ready' ? 'ready' : incoming.mode, snapshot: incoming };
};
