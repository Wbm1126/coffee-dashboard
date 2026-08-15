import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoffeeData } from '../../../domain/schema';
import { COLLECTION_FIELD_KEYS, type CollectionCandidate, type CollectionFieldKey, type CollectionFields, type SearchCandidate } from '../../../collectors/types';

type Preview = {
  duplicateBeans: Array<{ id: string; name: string; brandName: string }>;
  fields: Array<{ key: CollectionFieldKey; currentValue: unknown; proposedValue: unknown; defaultDecision: 'accept_candidate' | 'keep_existing' }>;
};

type Stage = 'idle' | 'loading' | 'preview' | 'manual';
type Price = { amount: number; currency: string };

const FIELD_LABELS: Record<CollectionFieldKey, string> = {
  brandName: '品牌', beanName: '豆名', roastLevel: '烘焙度', process: '处理法', flavorNotes: '风味标签',
  originOrVariety: '产地或品种', officialFlavorDescription: '官方风味描述', referencePrice: '参考价（CNY）', packageGrams: '规格（g）',
};

const FIELD_KEYS = COLLECTION_FIELD_KEYS;

function textError(body: unknown, fallback: string) {
  return typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : fallback;
}

async function postJson<T>(url: string, csrfToken: string, body: unknown, signal: AbortSignal): Promise<{ ok: boolean; status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body), signal,
  });
  let parsed: T;
  try { parsed = await response.json() as T; } catch { parsed = {} as T; }
  return { ok: response.ok, status: response.status, body: parsed };
}

function formatCurrent(value: unknown): string {
  if (value === null || value === undefined || value === '') return '尚无资料';
  if (Array.isArray(value)) return value.join('、') || '尚无资料';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function candidateFromManual(url: string, fields: CollectionFields, capturedAt: string): CollectionCandidate {
  const beanName = fields.beanName ?? '未命名咖啡豆';
  return { ...(url.trim() ? { sourceUrl: url.trim() } : {}), title: `${fields.brandName ?? '手工'} · ${beanName}`, capturedAt, sourceKind: 'user', fields };
}

interface CollectionWizardProps {
  csrfToken: string;
  data: CoffeeData;
  onDataChanged: () => Promise<void>;
}

export function CollectionWizard({ csrfToken, data, onDataChanged }: CollectionWizardProps) {
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [candidate, setCandidate] = useState<CollectionCandidate | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accepted, setAccepted] = useState<CollectionFields>({});
  const [mergeBeanId, setMergeBeanId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState('');
  const networkRequestInFlight = useRef(false);
  const mounted = useRef(true);
  const requestAbort = useRef<AbortController | null>(null);
  const requestDeadline = useRef<number | null>(null);
  const confirmationOperationKey = useRef(crypto.randomUUID());
  const manualCapturedAt = useRef(new Date().toISOString());

  useEffect(() => {
    // React development Strict Mode performs a mount-cleanup-mount cycle.
    // Re-enable this guard on the effective mount before accepting responses.
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestAbort.current?.abort();
      if (requestDeadline.current !== null) window.clearTimeout(requestDeadline.current);
    };
  }, []);

  const visibleKeys = useMemo(() => FIELD_KEYS.filter((key) => key === 'brandName' || key === 'beanName' || candidate?.fields[key] !== undefined || stage === 'manual'), [candidate, stage]);
  const beginConfirmationLifecycle = () => {
    confirmationOperationKey.current = crypto.randomUUID();
    manualCapturedAt.current = new Date().toISOString();
  };
  const defaultCandidate = (value: CollectionCandidate, nextPreview: Preview) => {
    const defaults = Object.fromEntries(FIELD_KEYS
      .filter((key) => value.fields[key] !== undefined && nextPreview.fields.find((field) => field.key === key)?.defaultDecision !== 'keep_existing')
      .map((key) => [key, value.fields[key]]));
    // Identity must stay editable even if an incomplete page omitted one part.
    if (!nextPreview.duplicateBeans.length) {
      defaults.brandName = value.fields.brandName ?? '';
      defaults.beanName = value.fields.beanName ?? '';
    }
    beginConfirmationLifecycle();
    setCandidate(value); setPreview(nextPreview); setAccepted(defaults as CollectionFields); setMergeBeanId(null); setStage('preview');
  };
  const beginNetworkRequest = () => {
    if (networkRequestInFlight.current) return null;
    networkRequestInFlight.current = true;
    const controller = new AbortController();
    requestAbort.current = controller;
    requestDeadline.current = window.setTimeout(() => controller.abort(), 15_000);
    return controller;
  };
  const finishNetworkRequest = (controller: AbortController) => {
    if (requestAbort.current !== controller) return;
    networkRequestInFlight.current = false;
    requestAbort.current = null;
    if (requestDeadline.current !== null) window.clearTimeout(requestDeadline.current);
    requestDeadline.current = null;
  };

  const search = async () => {
    const controller = beginNetworkRequest();
    if (!controller) return;
    setStage('loading'); setMessage('');
    try {
      const response = await postJson<{ candidates?: SearchCandidate[]; message?: string }>('/api/collect/search', csrfToken, { query }, controller.signal);
      if (!mounted.current) return;
      if (!response.ok) { setStage('idle'); setMessage(textError(response.body, '搜索暂时不可用。你可以继续手工填写。')); return; }
      setResults(response.body.candidates ?? []); setStage('idle');
      setMessage((response.body.candidates?.length ?? 0) ? `找到 ${response.body.candidates!.length} 个候选，请选择后继续解析。` : '没有找到可用候选。你可以保留关键词并改用链接或手工填写。');
    } catch {
      if (!mounted.current) return;
      setStage('idle'); setMessage('搜索连接中断。关键词仍保留，你可以重试或直接手工填写。');
    } finally { finishNetworkRequest(controller); }
  };

  const parse = async (nextUrl = url) => {
    if (!nextUrl.trim()) { setMessage('请先粘贴商品链接，或先用关键词搜索。'); return; }
    const controller = beginNetworkRequest();
    if (!controller) return;
    setUrl(nextUrl); setStage('loading'); setMessage('');
    try {
      const response = await postJson<{ candidate?: CollectionCandidate; preview?: Preview; message?: string }>('/api/collect/parse', csrfToken, { url: nextUrl }, controller.signal);
      if (!mounted.current) return;
      if (!response.ok || !response.body.candidate || !response.body.preview) {
        beginConfirmationLifecycle();
        setCandidate(null); setPreview(null); setAccepted({}); setStage('manual');
        setMessage(`${textError(response.body, '链接暂时无法解析。')} 你现在可以手工填写最少资料。`);
        return;
      }
      defaultCandidate(response.body.candidate, response.body.preview);
    } catch {
      if (!mounted.current) return;
      beginConfirmationLifecycle();
      setCandidate(null); setPreview(null); setAccepted({}); setStage('manual');
      setMessage('链接请求中断。原始链接仍保留，你现在可以手工填写最少资料。');
    } finally { finishNetworkRequest(controller); }
  };

  const beginManual = () => {
    beginConfirmationLifecycle();
    setCandidate(null); setPreview(null); setAccepted((current) => ({ ...current })); setMergeBeanId(null); setStage('manual');
    setMessage('不会自动创建记录。请填写品牌和豆名后，再确认加入关注。');
  };

  const setAcceptedValue = (key: CollectionFieldKey, value: string | string[] | Price | number | undefined) => {
    setAccepted((current) => ({ ...current, [key]: value }));
  };
  const toggleField = (key: CollectionFieldKey, checked: boolean) => {
    setAccepted((current) => {
      if (checked) return { ...current, [key]: candidate?.fields[key] ?? (key === 'flavorNotes' ? [] : '') };
      const next = { ...current }; delete next[key]; return next;
    });
  };

  const confirm = async () => {
    const fields = accepted;
    if (!mergeBeanId && (!fields.brandName?.trim() || !fields.beanName?.trim())) { setMessage('新建前至少要填写品牌和豆名；合并时可保留已有身份信息。'); return; }
    const controller = beginNetworkRequest();
    if (!controller) return;
    const confirmedCandidate = candidate ?? candidateFromManual(url, fields, manualCapturedAt.current);
    setStage('loading'); setMessage('');
    try {
      const response = await postJson<{ dataRevision?: number; message?: string }>('/api/collect/confirm', csrfToken, {
        expectedRevision: data.dataRevision, operationKey: confirmationOperationKey.current,
        action: mergeBeanId ? 'merge' : 'create', beanId: mergeBeanId, candidate: confirmedCandidate, acceptedFields: fields,
      }, controller.signal);
      if (!mounted.current) return;
      if (!response.ok) {
        setStage(candidate ? 'preview' : 'manual');
        setMessage(textError(response.body, '没有保存。当前输入仍保留，请检查后重试。'));
        if (response.status === 409) await onDataChanged();
        return;
      }
      beginConfirmationLifecycle();
      setStage('idle'); setResults([]); setCandidate(null); setPreview(null); setAccepted({}); setMergeBeanId(null);
      try {
        await onDataChanged();
        if (mounted.current) setMessage('已加入关注；商品来源和你确认过的字段都已保存在本地。');
      } catch {
        if (mounted.current) setMessage('已确认加入关注，但本地概览刷新失败；请刷新页面确认，勿重复提交。');
      }
    } catch {
      if (!mounted.current) return;
      setStage(candidate ? 'preview' : 'manual');
      setMessage('确认请求中断，保存结果未知。已保留当前输入，请刷新本地数据后确认是否需要重试。');
    } finally { finishNetworkRequest(controller); }
  };

  const cancel = () => {
    beginConfirmationLifecycle();
    setCandidate(null); setPreview(null); setAccepted({}); setMergeBeanId(null); setResults([]); setStage('idle');
    setMessage('已取消本次采集，没有创建或修改任何咖啡豆。链接和关键词仍保留，随时可以重新开始。');
  };

  return (
    <section className="collection-studio" id="collection-studio" aria-labelledby="collection-title">
      <div className="collection-studio__heading">
        <div><p className="section-kicker">FIELD NOTE / 03</p><h2 id="collection-title">联网采集与手工添加</h2></div>
        <p>只在你点击搜索或解析时联网；候选不会自动写入，字段由你逐项决定。</p>
      </div>
      <div className="collection-entry">
        <label><span>关键词</span><input aria-label="关键词" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="品牌或咖啡豆名称" /></label>
        <button className="button-outline" type="button" disabled={stage === 'loading' || query.trim().length < 2} onClick={() => void search()}>搜索候选</button>
        <span className="collection-entry__or" aria-hidden="true">或</span>
        <label><span>商品链接</span><input aria-label="商品链接" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" inputMode="url" /></label>
        <button className="button-primary" type="button" disabled={stage === 'loading'} onClick={() => void parse()}>解析链接</button>
      </div>
      <div className="collection-feedback" role="status" aria-live="polite">{stage === 'loading' ? '正在读取公开商品资料…' : message}</div>
      {results.length > 0 && <ol className="collection-results" aria-label="搜索候选">
        {results.map((result) => <li key={result.url}><div><b>{result.title}</b>{result.snippet && <small>{result.snippet}</small>}</div><button type="button" className="text-button" disabled={stage === 'loading'} onClick={() => void parse(result.url)}>解析此链接</button></li>)}
      </ol>}
      {(stage === 'preview' || stage === 'manual') && <div className="collection-confirmation">
        <div className="collection-confirmation__heading"><div><p className="section-kicker">CONFIRM BEFORE POUR</p><h3>确认这支豆的资料</h3></div><button type="button" className="text-button" onClick={cancel}>取消本次采集</button></div>
        {candidate && <p className="collection-source-note">候选来源：{candidate.sourceUrl} · 采集时间：{new Date(candidate.capturedAt).toLocaleString('zh-CN', { hour12: false })}</p>}
        {preview && preview.duplicateBeans.length > 0 && <fieldset className="collection-duplicates"><legend>发现可能重复的咖啡豆</legend><label><input type="radio" name="collection-target" checked={mergeBeanId === null} onChange={() => setMergeBeanId(null)} /> 创建一支新豆</label>{preview.duplicateBeans.map((bean) => <label key={bean.id}><input type="radio" name="collection-target" checked={mergeBeanId === bean.id} onChange={() => setMergeBeanId(bean.id)} /> 合并到「{bean.brandName} · {bean.name}」</label>)}</fieldset>}
        <div className="collection-fields">
          {visibleKeys.map((key) => {
            const selected = accepted[key] !== undefined;
            const previewField = preview?.fields.find((field) => field.key === key);
            const value = accepted[key];
            return <fieldset key={key} className="collection-field"><legend>{FIELD_LABELS[key]}</legend><label className="collection-field__toggle"><input type="checkbox" checked={selected} onChange={(event) => toggleField(key, event.target.checked)} /> 接受本项</label>
              {previewField?.currentValue !== null && previewField?.currentValue !== undefined && <small>现有值：{formatCurrent(previewField.currentValue)}（默认保留，除非你勾选新值）</small>}
              {key === 'flavorNotes' ? <input aria-label={FIELD_LABELS[key]} disabled={!selected} value={Array.isArray(value) ? value.join('、') : ''} onChange={(event) => setAcceptedValue(key, event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean))} />
                : key === 'referencePrice' ? <input aria-label={FIELD_LABELS[key]} disabled={!selected} type="number" min="0" step="0.01" value={typeof value === 'object' && value && !Array.isArray(value) ? value.amount : ''} onChange={(event) => setAcceptedValue(key, event.target.value ? { amount: Number(event.target.value), currency: 'CNY' } : undefined)} />
                  : key === 'packageGrams' ? <input aria-label={FIELD_LABELS[key]} disabled={!selected} type="number" min="1" value={typeof value === 'number' ? value : ''} onChange={(event) => setAcceptedValue(key, event.target.value ? Number(event.target.value) : undefined)} />
                    : key === 'officialFlavorDescription' ? <textarea aria-label={FIELD_LABELS[key]} disabled={!selected} value={typeof value === 'string' ? value : ''} onChange={(event) => setAcceptedValue(key, event.target.value || undefined)} />
                      : <input aria-label={FIELD_LABELS[key]} disabled={!selected} value={typeof value === 'string' ? value : ''} onChange={(event) => setAcceptedValue(key, event.target.value || undefined)} />}
            </fieldset>;
          })}
        </div>
        <div className="collection-actions"><button className="button-primary" type="button" onClick={() => void confirm()}>确认加入关注</button><span>个人评价、购买与饮用记录不会被联网资料修改。</span></div>
      </div>}
      {stage === 'idle' && !results.length && <button className="text-button collection-manual" type="button" onClick={beginManual}>不联网，直接手工填写</button>}
    </section>
  );
}
