import { useCallback, useEffect, useState } from 'react';
import { ImportWizard } from './features/import/ImportWizard';
import { PurchaseEditor } from './features/purchases/PurchaseEditor';
import { DrinkingEditor } from './features/drinking/DrinkingEditor';
import { RecordTimeline } from './features/history/RecordTimeline';
import { BeanGallery } from './features/gallery/BeanGallery';
import { RecommendationView } from './features/recommendations/RecommendationView';
import { CollectionWizard } from './features/collection/CollectionWizard';
import { RecoveryPanel } from './features/recovery/RecoveryPanel';
import { HomeView } from './features/home/HomeView';
import { advancePurchaseDraft, commitSnapshotState, purchaseEditorKey, readSnapshotResponse, type AppState, type EditingRecord, type PurchaseDraft } from './app-state';

type PrimaryView = 'home' | 'library' | 'records' | 'add';

const PRIMARY_VIEWS: Array<{ key: PrimaryView; label: string }> = [
  { key: 'home', label: '首页' },
  { key: 'library', label: '咖啡库' },
  { key: 'records', label: '记录' },
  { key: 'add', label: '添加' },
];

export function App() {
  const [{ mode, snapshot }, setAppState] = useState<AppState>({ mode: 'loading', snapshot: null });
  const [csrfToken, setCsrfToken] = useState('');
  const [view, setView] = useState<PrimaryView>('home');
  const [editingRecord, setEditingRecord] = useState<EditingRecord>(null);
  const [purchaseDirty, setPurchaseDirty] = useState(false);
  const [drinkingDirty, setDrinkingDirty] = useState(false);
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft>({ beanId: null, nonce: 0 });

  const refreshSnapshot = useCallback(async () => {
    const snapshotResponse = await fetch('/api/snapshot');
    const body = await readSnapshotResponse(snapshotResponse);
    setAppState((current) => commitSnapshotState(current, body));
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [sessionResponse, snapshotResponse] = await Promise.all([
          fetch('/api/session'),
          fetch('/api/snapshot'),
        ]);
        if (!sessionResponse.ok) throw new Error('无法建立本地安全会话。');
        const [session, snapshotBody] = await Promise.all([
          sessionResponse.json() as Promise<{ csrfToken: string }>,
          readSnapshotResponse(snapshotResponse),
        ]);
        if (!active) return;
        setCsrfToken(session.csrfToken);
        setAppState((current) => commitSnapshotState(current, snapshotBody));
      } catch {
        if (active) setAppState((current) => ({ ...current, mode: 'error' }));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [refreshSnapshot]);

  const beanCount = snapshot?.data?.beans.length ?? 0;
  const drinkingCount = snapshot?.data?.drinkingRecords.length ?? 0;
  const beginEditing = (kind: 'purchase' | 'drinking', id: string) => {
    if ((purchaseDirty || drinkingDirty) && !window.confirm('当前记录还有未保存修改，确定切换到另一条记录吗？')) return;
    setEditingRecord({ kind, id });
    window.setTimeout(() => document.getElementById('record-studio')?.scrollIntoView({ behavior: 'auto' }), 0);
  };
  const createPurchaseForBean = (beanId: string): boolean => {
    if ((purchaseDirty || drinkingDirty) && !window.confirm('当前记录还有未保存修改，确定开始一笔新购买吗？')) return false;
    setEditingRecord(null);
    setPurchaseDraft((current) => advancePurchaseDraft(current, beanId));
    setView('records');
    window.setTimeout(() => {
      document.getElementById('record-studio')?.scrollIntoView({ behavior: 'auto' });
      document.querySelector<HTMLElement>('[aria-label="购买日期"]')?.focus();
    }, 0);
    return true;
  };
  const goRecords = (focus: 'drink' | 'review') => {
    setView('records');
    window.setTimeout(() => {
      document.getElementById('record-studio')?.scrollIntoView({ behavior: 'auto' });
      if (focus === 'review') document.querySelector<HTMLElement>('[aria-label="美式评分"], [aria-label="奶咖评分"]')?.focus();
      else document.querySelector<HTMLElement>('[aria-labelledby="drinking-title"] select, [aria-labelledby="drinking-title"] input')?.focus();
    }, 0);
  };
  // 离开记录视图前拦截：编辑器草稿在组件内部，卸载即丢失。
  const switchView = (next: PrimaryView) => {
    if (view === 'records' && next !== 'records' && (purchaseDirty || drinkingDirty)
      && !window.confirm('当前记录还有未保存修改，确定离开吗？')) return;
    setView(next);
  };
  const goAdd = () => {
    setView('add');
    window.setTimeout(() => document.getElementById('collection-studio')?.scrollIntoView({ behavior: 'auto' }), 0);
  };

  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="brand-lockup" aria-label="豆迹咖啡豆个人看板">
          <span className="brand-seal" aria-hidden="true">
            豆
          </span>
          <div>
            <p className="eyebrow">LOCAL COFFEE ARCHIVE · 本地私藏</p>
            <h1>豆迹</h1>
          </div>
        </div>
        <p className="masthead-note">把购买和饮用分开记录，让每一次喜欢都有来路。</p>
        <nav className="primary-nav" aria-label="主导航">
          {PRIMARY_VIEWS.map((item) => (
            <button key={item.key} type="button" aria-current={view === item.key} onClick={() => switchView(item.key)}>{item.label}</button>
          ))}
        </nav>
      </header>

      <main id="main-content" tabIndex={-1}>
        {mode === 'ready' && csrfToken && view === 'home' && (
          <>
            <section className="hero" aria-labelledby="hero-title">
              <div className="hero-copy">
                <p className="section-kicker">FIRST POUR</p>
                <h2 id="hero-title">先把没来得及写下的味道，找回来。</h2>
                <p>收藏陈列馆、购买账本和品鉴记录都在本地；上面四条导航随时切换。</p>
              </div>
              <div className="roast-orbit" aria-hidden="true">
                <span className="orbit-label orbit-light">浅</span>
                <span className="orbit-label orbit-medium">中</span>
                <span className="orbit-label orbit-dark">深</span>
                <i className="orbit-seed" />
              </div>
            </section>
            <section className="status-strip" aria-labelledby="local-status-title">
              <div>
                <p className="section-kicker">LOCAL STATUS</p>
                <h2 id="local-status-title">本地数据已经就位</h2>
              </div>
              <dl>
                <div><dt>咖啡豆</dt><dd>{beanCount}</dd></div>
                <div><dt>饮用记录</dt><dd>{drinkingCount}</dd></div>
                <div><dt>数据版本</dt><dd>{snapshot?.data?.dataRevision ?? '—'}</dd></div>
              </dl>
            </section>
            <section className={`system-state system-state--${mode}`} aria-live="polite">
              <p>可离线浏览和记录。当前没有数据被发送到外部服务。</p>
            </section>
            {snapshot?.data && <HomeView csrfToken={csrfToken} data={snapshot.data} onDataChanged={refreshSnapshot} onGoAdd={goAdd} onGoRecords={goRecords} />}
            <details className="secondary-capabilities" aria-label="二级能力">
              <summary>二级能力：推荐 · 导出 · 迁移中心</summary>
              {snapshot?.data && <RecommendationView data={snapshot.data} csrfToken={csrfToken} onDataChanged={refreshSnapshot} onCreatePurchase={createPurchaseForBean} />}
              <ImportWizard csrfToken={csrfToken} onCommitted={refreshSnapshot} />
            </details>
          </>
        )}
        {mode === 'ready' && csrfToken && view === 'library' && (
          <>{snapshot?.data && <BeanGallery data={snapshot.data} csrfToken={csrfToken} onDataChanged={refreshSnapshot} onCreatePurchase={createPurchaseForBean} />}</>
        )}
        {mode === 'ready' && csrfToken && view === 'records' && snapshot?.data && (
          <section className="record-studio" id="record-studio" aria-labelledby="record-studio-title">
            <div className="record-studio__heading"><div><p className="section-kicker">DAILY LEDGER</p><h2 id="record-studio-title">购买和饮用，分开写清楚。</h2></div><p>购买可以有多支豆；每次饮用只选一支，也可以不关联历史购买项。</p></div>
            <div className="record-editors"><PurchaseEditor key={purchaseEditorKey(editingRecord, purchaseDraft)} csrfToken={csrfToken} data={snapshot.data} preselectedBeanId={purchaseDraft.beanId} initialPurchase={editingRecord?.kind === 'purchase' ? snapshot.data.purchases.find((item) => item.id === editingRecord.id) : undefined} onDataChanged={refreshSnapshot} onSaved={() => { setEditingRecord(null); setPurchaseDraft((current) => ({ ...current, beanId: null })); }} onDirtyChange={setPurchaseDirty} onCancelEdit={() => { setEditingRecord(null); setPurchaseDraft((current) => ({ ...current, beanId: null })); }} /><DrinkingEditor key={editingRecord?.kind === 'drinking' ? editingRecord.id : 'new-drinking'} csrfToken={csrfToken} data={snapshot.data} initialRecord={editingRecord?.kind === 'drinking' ? snapshot.data.drinkingRecords.find((item) => item.id === editingRecord.id) : undefined} onDataChanged={refreshSnapshot} onSaved={() => setEditingRecord(null)} onDirtyChange={setDrinkingDirty} onCancelEdit={() => setEditingRecord(null)} /></div>
            <RecordTimeline csrfToken={csrfToken} data={snapshot.data} onDataChanged={refreshSnapshot} onEditPurchase={(id) => beginEditing('purchase', id)} onEditDrinking={(id) => beginEditing('drinking', id)} />
          </section>
        )}
        {mode === 'ready' && csrfToken && view === 'add' && (
          <>{snapshot?.data && <CollectionWizard data={snapshot.data} csrfToken={csrfToken} onDataChanged={refreshSnapshot} />}</>
        )}
        {mode !== 'ready' && (
          <>
            <section className="status-strip" aria-labelledby="local-status-title">
              <div><p className="section-kicker">LOCAL STATUS</p><h2 id="local-status-title">本地数据</h2></div>
              <dl><div><dt>咖啡豆</dt><dd>{beanCount}</dd></div><div><dt>数据版本</dt><dd>{snapshot?.data?.dataRevision ?? '—'}</dd></div></dl>
            </section>
            <section className={`system-state system-state--${mode}`} aria-live="polite">
              {mode === 'loading' && <p>正在检查本地数据与恢复状态…</p>}
              {mode === 'read_only' && <p>数据版本高于当前应用，已用只读模式打开。请升级应用后再编辑。</p>}
              {mode === 'recovery' && <p>主数据需要恢复。应用已停止写入，请从通过校验的备份中选择恢复。</p>}
              {mode === 'error' && <p>无法连接本地服务。请确认服务已经启动后重试。</p>}
            </section>
          </>
        )}
        {mode === 'recovery' && csrfToken && <RecoveryPanel csrfToken={csrfToken} onRecovered={refreshSnapshot} />}
      </main>

      <footer>
        <span>数据留在这里，判断属于你。</span>
        <span>single user · local first · no telemetry</span>
      </footer>
    </div>
  );
}
