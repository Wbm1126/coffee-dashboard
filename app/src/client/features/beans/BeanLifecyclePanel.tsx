import { useRef, useState } from 'react';

interface BeanDeleteImpact {
  beanId: string;
  purchaseItemCount: number;
  drinkingRecordCount: number;
  assessmentCount: number;
  sourceCount: number;
  canPermanentlyDelete: boolean;
  action: 'archive' | 'permanently_delete';
}

interface Props {
  beanId: string;
  beanName: string;
  dataRevision: number;
  csrfToken: string;
  onDataChanged: () => Promise<void>;
  onCompleted: (action: 'archived' | 'permanently_deleted') => void;
}

type RefreshState = 'none' | 'committed' | 'conflict' | 'unknown';

export function BeanLifecyclePanel({ beanId, beanName, dataRevision, csrfToken, onDataChanged, onCompleted }: Props) {
  const [impact, setImpact] = useState<BeanDeleteImpact | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshState, setRefreshState] = useState<RefreshState>('none');
  const [committedAction, setCommittedAction] = useState<'archived' | 'permanently_deleted' | null>(null);
  const inFlight = useRef(false);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const impactActionRef = useRef<HTMLButtonElement>(null);

  const focusNextFrame = (target: { current: HTMLElement | null }) => {
    requestAnimationFrame(() => target.current?.focus());
  };

  const begin = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    return true;
  };
  const finish = () => {
    inFlight.current = false;
    setBusy(false);
  };

  const preview = async () => {
    if (!begin() || refreshState !== 'none') return;
    setMessage('');
    try {
      const response = await fetch(`/api/beans/${beanId}/delete-impact`);
      const body = await readJson<BeanDeleteImpact & { message?: string }>(response);
      if (!response.ok) {
        setMessage(body.message ?? '无法读取关联影响；咖啡豆没有归档或删除。');
        return;
      }
      setImpact(body);
      focusNextFrame(impactActionRef);
    } catch {
      setMessage('关联影响读取中断；咖啡豆没有归档或删除。');
    } finally {
      finish();
    }
  };

  const mutate = async () => {
    if (!impact || !begin() || refreshState !== 'none') return;
    if (impact.canPermanentlyDelete && !window.confirm(`将永久删除最小草稿「${beanName}」，且无法恢复。确定继续吗？`)) {
      setMessage('已取消永久删除；咖啡豆没有改变。');
      finish();
      return;
    }
    setMessage('');
    try {
      const response = await fetch(`/api/beans/${beanId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expectedRevision: dataRevision, confirmPermanent: true }),
      });
      const body = await readJson<{ action?: 'archived' | 'permanently_deleted'; error?: string; message?: string }>(response);
      if (!response.ok) {
        if (response.status === 409 || body.error === 'revision_conflict') {
          try {
            await onDataChanged();
            setImpact(null);
            setMessage('数据已在其他页面更新，已刷新到最新版本；请重新查看关联影响。');
            focusNextFrame(previewButtonRef);
          } catch {
            setRefreshState('conflict');
            setMessage('数据已在其他页面更新，操作没有执行，但刷新失败；请先重试刷新。');
          }
          return;
        }
        setMessage(body.message ?? '操作失败；咖啡豆没有改变。');
        return;
      }
      const action = body.action;
      if (!action) {
        setRefreshState('unknown');
        setMessage('服务端已接受操作，但结果无法确认；请刷新后核对，勿重复操作。');
        return;
      }
      try {
        await onDataChanged();
        onCompleted(action);
      } catch {
        setCommittedAction(action);
        setRefreshState('committed');
        setMessage(`${action === 'archived' ? '咖啡豆已归档' : '草稿已永久删除'}，但页面刷新失败；请先重试刷新，勿重复操作。`);
      }
    } catch {
      setRefreshState('unknown');
      setMessage('请求中断，结果未知；请先刷新核对，勿重复操作。');
    } finally {
      finish();
    }
  };

  const retryRefresh = async () => {
    if (!begin() || refreshState === 'none') return;
    const previousState = refreshState;
    try {
      await onDataChanged();
      if (previousState === 'committed') {
        if (!committedAction) throw new Error('committed_action_missing');
        onCompleted(committedAction);
        return;
      }
      if (previousState === 'unknown') {
        const response = await fetch('/api/snapshot');
        const body = await readJson<{ data?: { beans?: Array<{ id: string; archivedAt: string | null }> } }>(response);
        if (!response.ok || !body.data?.beans) throw new Error('snapshot_reconciliation_failed');
        const bean = body.data.beans.find((candidate) => candidate.id === beanId);
        if (!bean) {
          onCompleted('permanently_deleted');
          return;
        }
        if (bean.archivedAt) {
          onCompleted('archived');
          return;
        }
      }
      setRefreshState('none');
      setImpact(null);
      setMessage('数据已刷新；请重新查看关联影响后再操作。');
      focusNextFrame(previewButtonRef);
    } catch {
      setMessage('刷新仍未完成；请勿重复操作。');
    } finally {
      finish();
    }
  };

  const referenceCount = impact
    ? impact.purchaseItemCount + impact.drinkingRecordCount + impact.assessmentCount + impact.sourceCount
    : 0;
  const disabled = busy || refreshState !== 'none';

  return <section className="bean-lifecycle" aria-labelledby="bean-lifecycle-title">
    <h3 id="bean-lifecycle-title">归档与删除</h3>
    <p className="unknown-note">先检查购买、饮用、评价和商品来源。有关联历史的豆只会归档，不会级联删除事实。</p>
    {!impact && <button ref={previewButtonRef} type="button" className="text-button" disabled={disabled} onClick={() => void preview()}>{busy ? '正在检查…' : '查看归档或删除影响'}</button>}
    {impact && <div className="bean-delete-impact" role="alert">
      <strong>{impact.canPermanentlyDelete ? '允许永久删除最小草稿' : '只能归档，历史记录会保留'}</strong>
      <dl>
        <div><dt>购买项</dt><dd>{impact.purchaseItemCount}</dd></div>
        <div><dt>饮用记录</dt><dd>{impact.drinkingRecordCount}</dd></div>
        <div><dt>综合评价</dt><dd>{impact.assessmentCount}</dd></div>
        <div><dt>商品来源</dt><dd>{impact.sourceCount}</dd></div>
      </dl>
      <p>{impact.canPermanentlyDelete
        ? '这支豆是没有任何事实引用的最小草稿。永久删除仍需再确认一次。'
        : referenceCount > 0
          ? `共有 ${referenceCount} 条关联事实；归档后它们仍可追溯。`
          : '这支豆不是最小草稿，因此不会永久删除；归档后资料仍保留。'}</p>
      <div className="bean-delete-impact__actions">
        <button ref={impactActionRef} type="button" className={impact.canPermanentlyDelete ? 'button-outline' : 'button-primary'} disabled={disabled} onClick={() => void mutate()}>{busy ? '处理中…' : impact.canPermanentlyDelete ? '永久删除这支草稿' : '确认归档'}</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => { setImpact(null); setMessage('已取消；咖啡豆没有改变。'); focusNextFrame(previewButtonRef); }}>取消</button>
      </div>
    </div>}
    {message && <p className="record-message" role="status" aria-live="polite">{message}</p>}
    {refreshState !== 'none' && <button type="button" className="button-outline" disabled={busy} onClick={() => void retryRefresh()}>{busy ? '刷新中…' : '重试刷新'}</button>}
  </section>;
}

async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; } catch { return {} as T; }
}
