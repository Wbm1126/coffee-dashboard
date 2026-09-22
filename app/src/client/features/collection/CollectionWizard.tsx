import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoffeeData } from '../../../domain/schema';
import { COLLECTION_FIELD_KEYS, type CollectionCandidate, type CollectionFieldKey, type CollectionFields } from '../../../collectors/types';

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
  const [input, setInput] = useState('');
  const [url, setUrl] = useState('');
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
  const beginNetworkRequest = (timeoutMs = 15_000) => {
    if (networkRequestInFlight.current) return null;
    networkRequestInFlight.current = true;
    const controller = new AbortController();
    requestAbort.current = controller;
    requestDeadline.current = window.setTimeout(() => controller.abort(), timeoutMs);
    return controller;
  };
  const finishNetworkRequest = (controller: AbortController) => {
    if (requestAbort.current !== controller) return;
    networkRequestInFlight.current = false;
    requestAbort.current = null;
    if (requestDeadline.current !== null) window.clearTimeout(requestDeadline.current);
    requestDeadline.current = null;
  };

  const auto = async () => {
    const value = input.trim();
    if (!value) { setMessage('请先粘贴商品链接、输入品牌加豆名，或粘贴一段商品介绍。'); return; }
    // 服务端要串行完成搜索 + 解析两次外部请求，客户端预算放宽到 22 秒。
    const controller = beginNetworkRequest(22_000);
    if (!controller) return;
    setStage('loading'); setMessage('');
    try {
      const response = await postJson<{ kind?: 'candidate' | 'manual'; candidate?: CollectionCandidate; preview?: Preview; fields?: CollectionFields; searchMatched?: string; reason?: string; message?: string }>('/api/collect/auto', csrfToken, { input: value }, controller.signal);
      if (!mounted.current) return;
      if (response.ok && response.body.kind === 'candidate' && response.body.candidate && response.body.preview) {
        setUrl(response.body.candidate.sourceUrl ?? '');
        defaultCandidate(response.body.candidate, response.body.preview);
        setMessage(response.body.searchMatched ? `已自动匹配候选：${response.body.searchMatched}` : '');
        return;
      }
      beginConfirmationLifecycle();
      setCandidate(null); setPreview(null);
      setAccepted((response.body.fields ?? {}) as CollectionFields);
      setMergeBeanId(null); setStage('manual');
      setMessage(response.body.reason ?? textError(response.body, '没有自动找到资料；已按输入预填，请核对品牌和豆名后保存。'));
    } catch {
      if (!mounted.current) return;
      beginConfirmationLifecycle();
      setCandidate(null); setPreview(null); setAccepted({}); setMergeBeanId(null); setStage('manual');
      setMessage('请求中断。已保留输入，请手工核对品牌和豆名后保存。');
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
      setStage('idle'); setUrl(''); setCandidate(null); setPreview(null); setAccepted({}); setMergeBeanId(null);
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
    setUrl(''); setCandidate(null); setPreview(null); setAccepted({}); setMergeBeanId(null); setStage('idle');
    setMessage('已取消本次采集，没有创建或修改任何咖啡豆。输入内容已清空，随时可以重新开始。');
  };

  return (
    <section className="collection-studio" id="collection-studio" aria-labelledby="collection-title">
      <div className="collection-studio__heading">
        <div><p className="section-kicker">FIELD NOTE / 03</p><h2 id="collection-title">添加咖啡豆</h2></div>
        <p>一个输入框即可：粘贴商品链接、输入「品牌 豆名」，或直接粘贴商品介绍。搜索与解析由系统自动完成，候选不会自动写入。</p>
      </div>
      <div className="collection-entry">
        <label><span>添加咖啡豆</span><textarea aria-label="添加咖啡豆" rows={3} value={input} onChange={(event) => setInput(event.target.value)} placeholder={'例如：https://… 或 乔治队长 黑猫拼配\n也可以直接粘贴一段商品介绍'} /></label>
        <button className="button-primary" type="button" disabled={stage === 'loading' || input.trim().length < 2} onClick={() => void auto()}>自动识别</button>
      </div>
      <div className="collection-feedback" role="status" aria-live="polite">{stage === 'loading' ? '正在读取公开商品资料…' : message}</div>
      {(stage === 'preview' || stage === 'manual') && <div className="collection-confirmation">
        <div className="collection-confirmation__heading"><div><p className="section-kicker">CONFIRM BEFORE POUR</p><h3>确认这支豆的资料</h3></div><button type="button" className="text-button" onClick={cancel}>取消本次采集</button></div>
        {candidate && <p className="collection-source-note">候选来源：{candidate.sourceUrl} · 采集时间：{new Date(candidate.capturedAt).toLocaleString('zh-CN', { hour12: false })}</p>}
        {preview && preview.duplicateBeans.length > 0 && <fieldset className="collection-duplicates"><legend>发现可能重复的咖啡豆</legend><label><input type="radio" name="collection-target" checked={mergeBeanId === null} onChange={() => setMergeBeanId(null)} /> 创建一支新豆</label>{preview.duplicateBeans.map((bean) => <label key={bean.id}><input type="radio" name="collection-target" checked={mergeBeanId === bean.id} onChange={() => setMergeBeanId(bean.id)} /> 合并到「{bean.brandName} · {bean.name}」</label>)}</fieldset>}
        <fieldset className="collection-zone"><legend>自动获取的资料（逐项确认，均可修改）</legend>
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
        </fieldset>
        <details className="collection-personal">
          <summary>个人信息（个人评价可稍后再补）</summary>
          <p>品牌加豆名即可先保存。个人评分、冲煮记录和购买记录都在保存后的详情页里补录，联网资料永远不会覆盖它们。</p>
        </details>
        <div className="collection-actions"><button className="button-primary" type="button" onClick={() => void confirm()}>保存这支豆（品牌 + 豆名即可）</button><span>个人评价、购买与饮用记录不会被联网资料修改。</span></div>
      </div>}
      {stage === 'idle' && !candidate && <button className="text-button collection-manual" type="button" onClick={beginManual}>不联网，直接手工填写</button>}
    </section>
  );
}
