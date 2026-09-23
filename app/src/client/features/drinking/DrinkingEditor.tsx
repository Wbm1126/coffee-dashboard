import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createUnreviewedReview } from '../../../domain/review-defaults';
import type { BrewMethod, BrewParams, CoffeeData, Repurchase, Review } from '../../../domain/schema';
import { formatLocalDate } from '../../local-date';
import { usePostSaveRefresh } from '../../use-post-save-refresh';
import { BREW_METHOD_OPTIONS, GRADE_OPTIONS, REPURCHASE_OPTIONS, REVIEW_SCORE_OPTIONS, REVIEW_STATE_OPTIONS } from '../reviews/review-options';

type DrinkRecord = CoffeeData['drinkingRecords'][number];

interface Props { csrfToken: string; data: CoffeeData; initialRecord?: DrinkRecord; onDataChanged: () => Promise<void>; onSaved: () => void; onDirtyChange: (dirty: boolean) => void; onCancelEdit: () => void }

function Dimension({ label, value, onChange }: { label: '美式' | '奶咖'; value: Review; onChange: (review: Review) => void }) {
  return <fieldset><legend>{label}评价</legend><label>状态<select aria-label={`${label}评价状态`} value={value.state} onChange={(event) => { const state = event.target.value as Review['state']; onChange({ ...value, state, score: state === 'reviewed' ? value.score : null }); }}>{REVIEW_STATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    {value.state === 'reviewed' && <div className="review-fields"><label>评分<select aria-label={`${label}评分`} required value={value.score ?? ''} onChange={(event) => onChange({ ...value, score: event.target.value ? Number(event.target.value) : null })}><option value="">请选择</option>{REVIEW_SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}</select></label>
      <label className="field-wide">风味标签<input aria-label={`${label}风味标签`} value={value.flavorNotes.join('、')} onChange={(event) => onChange({ ...value, flavorNotes: event.target.value.split(/[、，,]/).map((part) => part.trim()).filter(Boolean) })} /></label>
      <label>优点<textarea aria-label={`${label}优点`} value={value.pros ?? ''} onChange={(event) => onChange({ ...value, pros: event.target.value || null })} /></label>
      <label>不足<textarea aria-label={`${label}不足`} value={value.cons ?? ''} onChange={(event) => onChange({ ...value, cons: event.target.value || null })} /></label>
      <label className="field-wide">补充品鉴<textarea aria-label={`${label}补充品鉴`} value={value.note ?? ''} onChange={(event) => onChange({ ...value, note: event.target.value || null })} /></label></div>}
  </fieldset>;
}

function emptyBrewParams(): BrewParams {
  return { doseGrams: null, yieldGrams: null, brewTimeSeconds: null, temperatureC: null, grindSetting: null, waterGrams: null, milkGrams: null };
}

// 按喝法取当前评价轨：奶咖走奶咖轨，其余（美式/浓缩/其他）都走美式轨；另一轨保留原状、可日后独立补充。
function trackFor(brewMethod: BrewMethod): { key: 'americanoReview' | 'milkReview'; label: '美式' | '奶咖' } {
  return brewMethod === 'milk' ? { key: 'milkReview', label: '奶咖' } : { key: 'americanoReview', label: '美式' };
}

function describeBrewParams(params: BrewParams | null): string {
  if (!params) return '';
  const parts: string[] = [];
  if (params.doseGrams !== null) parts.push(`${params.doseGrams}g粉`);
  if (params.yieldGrams !== null) parts.push(`${params.yieldGrams}g液`);
  if (params.waterGrams !== null) parts.push(`${params.waterGrams}g水`);
  if (params.milkGrams !== null) parts.push(`${params.milkGrams}g奶`);
  if (params.temperatureC !== null) parts.push(`${params.temperatureC}°C`);
  if (params.grindSetting !== null) parts.push(`${params.grindSetting}研磨`);
  if (params.brewTimeSeconds !== null) parts.push(`${params.brewTimeSeconds}秒`);
  return parts.join(' · ');
}

// 全空参数不算"有配方"：编辑器总是提交完整对象，全空记录不应遮蔽更早的真实配方。
function hasBrewParams(params: BrewParams | null): params is BrewParams {
  return !!params && Object.values(params).some((value) => value !== null);
}

export function DrinkingEditor({ csrfToken, data, initialRecord, onDataChanged, onSaved, onDirtyChange, onCancelEdit }: Props) {
  const beans = data.beans.filter((bean) => !bean.archivedAt || bean.id === initialRecord?.beanId); const first = beans[0]?.id ?? '';
  const initialBeanId = initialRecord?.beanId ?? first;
  const initialAssessment = data.assessments.find((item) => item.beanId === initialBeanId);
  const [beanId, setBeanId] = useState(initialBeanId); const selectedBean = beanId || first;
  const [purchaseItemId, setPurchaseItemId] = useState(initialRecord?.purchaseItemId ?? '');
  const [drankOn, setDrankOn] = useState(initialRecord?.drankOn ?? formatLocalDate());
  const [brewMethod, setBrewMethod] = useState<BrewMethod>(initialRecord?.brewMethod ?? 'americano');
  const [extractionNote, setExtractionNote] = useState(initialRecord?.extractionNote ?? ''); const [feeling, setFeeling] = useState(initialRecord?.feeling ?? '');
  const [americanoReview, setAmericanoReview] = useState<Review>(initialRecord?.americanoReview ?? createUnreviewedReview());
  const [milkReview, setMilkReview] = useState<Review>(initialRecord?.milkReview ?? createUnreviewedReview());
  const [brewParams, setBrewParams] = useState<BrewParams>(initialRecord?.brewParams ?? emptyBrewParams());
  const [grade, setGrade] = useState(initialAssessment?.grade ?? ''); const [repurchase, setRepurchase] = useState<Repurchase | ''>(initialAssessment?.repurchase ?? ''); const [summary, setSummary] = useState(initialAssessment?.summary ?? '');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const { refreshPending, refreshAfterSave } = usePostSaveRefresh(onDataChanged, onSaved);
  const activePurchases = useMemo(() => new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id)), [data.purchases]);
  const items = data.purchaseItems.filter((item) => item.beanId === selectedBean && activePurchases.has(item.purchaseId));
  const track = trackFor(brewMethod);
  const trackReview = track.key === 'americanoReview' ? americanoReview : milkReview;
  const setTrackReview = (review: Review) => { if (track.key === 'americanoReview') setAmericanoReview(review); else setMilkReview(review); };
  // 照上次再来一杯：取该豆最近一条带真实冲煮参数的记录，预填方式/参数/萃取备注；只复制配方，不改评价状态。
  const lastBrew = useMemo(() => data.drinkingRecords
    .filter((record) => record.beanId === selectedBean && !record.deletedAt && hasBrewParams(record.brewParams) && record.id !== initialRecord?.id)
    .sort((left, right) => (right.drankOn + right.createdAt).localeCompare(left.drankOn + left.createdAt))[0] ?? null, [data.drinkingRecords, selectedBean, initialRecord?.id]);
  const applyLastBrew = () => {
    if (!lastBrew?.brewParams) return;
    setBrewMethod(lastBrew.brewMethod);
    setBrewParams(structuredClone(lastBrew.brewParams));
    setExtractionNote(lastBrew.extractionNote ?? '');
  };
  const snapshot = JSON.stringify({ selectedBean, purchaseItemId, drankOn, brewMethod, extractionNote, brewParams, feeling, americanoReview, milkReview, grade, repurchase, summary });
  const [baseline, setBaseline] = useState(snapshot); const dirty = snapshot !== baseline;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const selectBean = (nextBeanId: string) => {
    const nextAssessment = data.assessments.find((item) => item.beanId === nextBeanId);
    setBeanId(nextBeanId);
    setPurchaseItemId('');
    setGrade(nextAssessment?.grade ?? '');
    setRepurchase(nextAssessment?.repurchase ?? '');
    setSummary(nextAssessment?.summary ?? '');
  };
  const setBrewParam = <K extends keyof BrewParams>(key: K, value: BrewParams[K]) => setBrewParams((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setMessage('');
    try { const response = await fetch('/api/drinking/save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({
      expectedRevision: data.dataRevision, beanId: selectedBean, purchaseItemId: purchaseItemId || null, drinkingRecordId: initialRecord?.id ?? null,
      drankOn, brewMethod, extractionNote: extractionNote || null, brewParams, feeling: feeling || null, americanoReview, milkReview, isDraft: false,
      assessment: { grade: grade || null, repurchase: repurchase || null, summary: summary || null } }) });
      const body = await response.json() as { message?: string; reviewComplete?: boolean }; if (!response.ok) throw new Error(body.message ?? '饮用记录未保存。');
      setBaseline(snapshot);
      const successMessage = initialRecord ? '饮用更正已保存，没有创建重复记录。' : body.reviewComplete ? '饮用与计划评价已完整保存。' : '饮用已保存；未评价维度仍是待补，不会按零分处理。';
      setMessage(await refreshAfterSave() ? successMessage : '饮用已保存，但刷新失败；请点击“重试刷新”，勿重复提交。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '饮用记录未保存。'); } finally { setBusy(false); } };
  return <section className="record-card" aria-labelledby="drinking-title"><p className="section-kicker">DRINK / 单豆饮用</p><h3 id="drinking-title">一次只记录一支豆</h3>{initialRecord && <p className="editing-notice">正在更正已有饮用；保存会更新原记录。</p>}
    {beans.length === 0 ? <p>先建立至少一支咖啡豆，再记录饮用。</p> : <form onSubmit={(event) => void submit(event)}><div className="record-grid">
      <label>咖啡豆<select aria-label="饮用咖啡豆" value={selectedBean} onChange={(event) => selectBean(event.target.value)}>{beans.map((bean) => <option key={bean.id} value={bean.id}>{bean.name}</option>)}</select></label>
      <label>饮用日期<input aria-label="饮用日期" type="date" value={drankOn} onChange={(event) => setDrankOn(event.target.value)} /></label>
      <label>冲煮方式<select aria-label="冲煮方式" value={brewMethod} onChange={(event) => setBrewMethod(event.target.value as BrewMethod)}>{BREW_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>{track.label}评分<select aria-label={`${track.label}评分`} required={trackReview.state === 'reviewed'} value={trackReview.score ?? ''} onChange={(event) => { const score = event.target.value ? Number(event.target.value) : null; setTrackReview(score === null ? { ...trackReview, state: 'unreviewed', score: null } : { ...trackReview, state: 'reviewed', score }); }}><option value="">请选择</option>{REVIEW_SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}</select></label>
      <label className="field-wide">一句感受<input aria-label="饮用感受" value={feeling} onChange={(event) => setFeeling(event.target.value)} placeholder="一句话记录当下的味道与感受" /></label></div>
      {lastBrew && <p className="last-brew-note">上次冲煮（{lastBrew.drankOn}）：{describeBrewParams(lastBrew.brewParams) || '未记录参数'}<button type="button" className="text-button" onClick={applyLastBrew}>照上次再来一杯</button></p>}
      <details className="brew-details"><summary>展开详细记录（风味 / 优缺点 / 萃取参数 / 综合结论）</summary>
        <label className="field-wide">萃取备注<input aria-label="萃取备注" value={extractionNote} onChange={(event) => setExtractionNote(event.target.value)} /></label>
        <Dimension label={track.label} value={trackReview} onChange={setTrackReview} />
        <fieldset className="brew-params"><legend>冲煮参数（留空 = 未记录，供下次复用）</legend>
          <label>粉量 g<input aria-label="粉量克数" type="number" min="0.1" step="0.1" value={brewParams.doseGrams ?? ''} onChange={(event) => setBrewParam('doseGrams', event.target.value ? Number(event.target.value) : null)} /></label>
          <label>液量 g<input aria-label="液量克数" type="number" min="0.1" step="0.1" value={brewParams.yieldGrams ?? ''} onChange={(event) => setBrewParam('yieldGrams', event.target.value ? Number(event.target.value) : null)} /></label>
          <label>时间 秒<input aria-label="冲煮秒数" type="number" min="1" step="1" value={brewParams.brewTimeSeconds ?? ''} onChange={(event) => setBrewParam('brewTimeSeconds', event.target.value ? Number(event.target.value) : null)} /></label>
          <label>水温 °C<input aria-label="水温" type="number" min="0" max="100" step="1" value={brewParams.temperatureC ?? ''} onChange={(event) => setBrewParam('temperatureC', event.target.value ? Number(event.target.value) : null)} /></label>
          <label>研磨度<input aria-label="研磨度" value={brewParams.grindSetting ?? ''} onChange={(event) => setBrewParam('grindSetting', event.target.value || null)} /></label>
          <label>水量 g<input aria-label="水量克数" type="number" min="0.1" step="0.1" value={brewParams.waterGrams ?? ''} onChange={(event) => setBrewParam('waterGrams', event.target.value ? Number(event.target.value) : null)} /></label>
          <label>奶量 g<input aria-label="奶量克数" type="number" min="0.1" step="0.1" value={brewParams.milkGrams ?? ''} onChange={(event) => setBrewParam('milkGrams', event.target.value ? Number(event.target.value) : null)} /></label>
        </fieldset>
        <label>关联购买项（可选）<select aria-label="关联购买项" value={purchaseItemId} onChange={(event) => setPurchaseItemId(event.target.value)}><option value="">历史饮用 / 不关联</option>{items.map((item) => <option key={item.id} value={item.id}>{item.packageGrams ? `${item.packageGrams}g` : '规格未知'} · {item.bagStatus}</option>)}</select></label>
        <fieldset className="personal-verdict"><legend>综合结论</legend><label>个人等级<select aria-label="个人等级" value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">暂不定级</option>{GRADE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>是否回购<select aria-label="是否回购" value={repurchase} onChange={(event) => setRepurchase(event.target.value as Repurchase | '')}><option value="">暂不判断</option>{REPURCHASE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="field-wide">一句总结<textarea aria-label="一句总结" value={summary} onChange={(event) => setSummary(event.target.value)} /></label></fieldset>
      </details>
      <div className="record-actions">{initialRecord && <button type="button" className="text-button" onClick={() => { if (!dirty || window.confirm('饮用更正尚未保存，确定退出吗？')) onCancelEdit(); }}>取消更正</button>}{refreshPending && <button type="button" className="button-outline" disabled={busy} onClick={async () => { setBusy(true); setMessage(await refreshAfterSave() ? '饮用数据已刷新。' : '刷新仍未完成；已保存的饮用不会重复写入。'); setBusy(false); }}>重试刷新</button>}<button type="submit" className="button-primary" disabled={busy || refreshPending}>{busy ? '保存中…' : initialRecord ? '保存更正' : '保存饮用'}</button></div></form>}
    {message && <p className="record-message" role="status">{message}</p>}</section>;
}
