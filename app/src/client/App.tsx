import { useEffect, useState } from 'react';

type AppMode = 'loading' | 'ready' | 'read_only' | 'recovery' | 'error';

interface SnapshotResponse {
  mode: 'ready' | 'read_only' | 'recovery';
  data?: {
    dataRevision: number;
    beans: unknown[];
    drinkingRecords: unknown[];
  };
  reason?: string;
}

export function App() {
  const [mode, setMode] = useState<AppMode>('loading');
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const sessionResponse = await fetch('/api/session');
        if (!sessionResponse.ok) throw new Error('无法建立本地安全会话。');
        const snapshotResponse = await fetch('/api/snapshot');
        const body = (await snapshotResponse.json()) as SnapshotResponse;
        if (!active) return;
        setSnapshot(body);
        setMode(body.mode === 'ready' ? 'ready' : body.mode);
      } catch {
        if (active) setMode('error');
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const beanCount = snapshot?.data?.beans.length ?? 0;
  const drinkingCount = snapshot?.data?.drinkingRecords.length ?? 0;

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
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="section-kicker">FIRST POUR / 01</p>
            <h2 id="hero-title">先把没来得及写下的味道，找回来。</h2>
            <p>
              从四月的旧表格继续。这里会成为你的收藏陈列馆、购买账本和品鉴记录，而不是另一张越填越累的表。
            </p>
            <div className="hero-actions" aria-label="首要操作">
              <button type="button" disabled>
                开始补评价
              </button>
              <span>迁移工具将在下一实施单元开放</span>
            </div>
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
            <div>
              <dt>咖啡豆</dt>
              <dd>{beanCount}</dd>
            </div>
            <div>
              <dt>饮用记录</dt>
              <dd>{drinkingCount}</dd>
            </div>
            <div>
              <dt>数据版本</dt>
              <dd>{snapshot?.data?.dataRevision ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <section className={`system-state system-state--${mode}`} aria-live="polite">
          {mode === 'loading' && <p>正在检查本地数据与恢复状态…</p>}
          {mode === 'ready' && <p>可离线浏览和记录。当前没有数据被发送到外部服务。</p>}
          {mode === 'read_only' && (
            <p>数据版本高于当前应用，已用只读模式打开。请升级应用后再编辑。</p>
          )}
          {mode === 'recovery' && (
            <p>主数据需要恢复。应用已停止写入，请从通过校验的备份中选择恢复。</p>
          )}
          {mode === 'error' && <p>无法连接本地服务。请确认服务已经启动后重试。</p>}
        </section>
      </main>

      <footer>
        <span>数据留在这里，判断属于你。</span>
        <span>single user · local first · no telemetry</span>
      </footer>
    </div>
  );
}

