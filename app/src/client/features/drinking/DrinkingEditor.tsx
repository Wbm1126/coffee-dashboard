import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createUnreviewedReview } from '../../../domain/review-defaults';
import type { BrewMethod, CoffeeData, Repurchase, Review } from '../../../domain/schema';
import { formatLocalDate } from '../../local-date';
import { usePostSaveRefresh } from '../../use-post-save-refresh';
import { BREW_METHOD_OPTIONS, GRADE_OPTIONS, REPURCHASE_OPTIONS, REVIEW_SCORE_OPTIONS, REVIEW_STATE_OPTIONS } from '../reviews/review-options';

interface Props { csrfToken: string; data: CoffeeData; initialRecord?: CoffeeData['drinkingRecords'][number]; onDataChanged: () => Promise<void>; onSaved: () => void; onDirtyChange: (dirty: boolean) => void; onCancelEdit: () => void }

function Dimension({ label, value, onChange }: { label: '美式' | '奶咖'; value: Review; onChange: (review: Review) => void }) {
  return <fieldset><legend>{label}评价</legend><label>状态<select aria-label={`${label}评价状态`} value={value.state} onChange={(event) => { const state = event.target.value as Review['state']; onChange({ ...value, state, score: state === 'reviewed' ? value.score : null }); }}>{REVIEW_STATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    {value.state === 'reviewed' && <div className="review-fields"><label>评分<select aria-label={`${label}评分`} required value={value.score ?? ''} onChange={(event) => onChange({ ...value, score: event.target.value ? Number(event.target.value) : null })}><option value="">请选择</option>{REVIEW_SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}</select></label>
      <label className="field-wide">风味标签<input aria-label={`${label}风味标签`} value={value.flavorNotes.join('、')} onChange={(event) => onChange({ ...value, flavorNotes: event.target.value.split(/[、，,]/).map((part) => part.trim()).filter(Boolean) })} /></label>
      <label>优点<textarea aria-label={`${label}优点`} value={value.pros ?? ''} onChange={(event) => onChange({ ...value, pros: event.target.value || null })} /></label>
      <label>不足<textarea aria-label={`${label}不足`} value={value.cons ?? ''} onChange={(event) => onChange({ ...value, cons: event.target.value || null })} /></label>
      <label className="field-wide">补充品鉴<textarea aria-label={`${label}补充品鉴`} value={value.note ?? ''} onChange={(event) => onChange({ ...value, note: event.target.value || null })} /></label></div>}
  </fieldset>;
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
  const [grade, setGrade] = useState(initialAssessment?.grade ?? ''); const [repurchase, setRepurchase] = useState<Repurchase | ''>(initialAssessment?.repurchase ?? ''); const [summary, setSummary] = useState(initialAssessment?.summary ?? '');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const { refreshPending, refreshAfterSave } = usePostSaveRefresh(onDataChanged, onSaved);
  const activePurchases = useMemo(() => new Set(data.purchases.filter((purchase) => !purchase.deletedAt).map((purchase) => purchase.id)), [data.purchases]);
  const items = data.purchaseItems.filter((item) => item.beanId === selectedBean && activePurchases.has(item.purchaseId));
  const snapshot = JSON.stringify({ selectedBean, purchaseItemId, drankOn, brewMethod, extractionNote, feeling, americanoReview, milkReview, grade, repurchase, summary });
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
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setMessage('');
    try { const response = await fetch('/api/drinking/save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({
      expectedRevision: data.dataRevision, beanId: selectedBean, purchaseItemId: purchaseItemId || null, drinkingRecordId: initialRecord?.id ?? null,
      drankOn, brewMethod, extractionNote: extractionNote || null, feeling: feeling || null, americanoReview, milkReview, isDraft: false,
      assessment: { grade: grade || null, repurchase: repurchase || null, summary: summary || null } }) });
      const body = await response.json() as { message?: string; reviewComplete?: boolean }; if (!response.ok) throw new Error(body.message ?? '饮用记录未保存。');
      setBaseline(snapshot);
      const successMessage = initialRecord ? '饮用更正已保存，没有创建重复记录。' : body.reviewComplete ? '饮用与计划评价已完整保存。' : '饮用已保存；未评价维度仍是待补，不会按零分处理。';
      setMessage(await refreshAfterSave() ? successMessage : '饮用已保存，但刷新失败；请点击“重试刷新”，勿重复提交。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '饮用记录未保存。'); } finally { setBusy(false); } };
  return <section className="record-card" aria-labelledby="drinking-title"><p className="section-kicker">DRINK / 单豆饮用</p><h3 id="drinking-title">一次只记录一支豆</h3>{initialRecord && <p className="editing-notice">正在更正已有饮用；保存会更新原记录。</p>}
    {beans.length === 0 ? <p>先建立至少一支咖啡豆，再记录饮用。</p> : <form onSubmit={(event) => void submit(event)}><div className="record-grid">
      <label>咖啡豆<select aria-label="饮用咖啡豆" value={selectedBean} onChange={(event) => selectBean(event.target.value)}>{beans.map((bean) => <option key={bean.id} value={bean.id}>{bean.name}</option>)}</select></label>
      <label>关联购买项（可选）<select aria-label="关联购买项" value={purchaseItemId} onChange={(event) => setPurchaseItemId(event.target.value)}><option value="">历史饮用 / 不关联</option>{items.map((item) => <option key={item.id} value={item.id}>{item.packageGrams ? `${item.packageGrams}g` : '规格未知'} · {item.bagStatus}</option>)}</select></label>
      <label>饮用日期<input aria-label="饮用日期" type="date" value={drankOn} onChange={(event) => setDrankOn(event.target.value)} /></label>
      <label>冲煮方式<select aria-label="冲煮方式" value={brewMethod} onChange={(event) => setBrewMethod(event.target.value as BrewMethod)}>{BREW_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="field-wide">萃取备注<input aria-label="萃取备注" value={extractionNote} onChange={(event) => setExtractionNote(event.target.value)} /></label>
      <label className="field-wide">感受<textarea aria-label="饮用感受" value={feeling} onChange={(event) => setFeeling(event.target.value)} /></label></div>
      <div className="review-pair"><Dimension label="美式" value={americanoReview} onChange={setAmericanoReview} /><Dimension label="奶咖" value={milkReview} onChange={setMilkReview} /></div>
      <fieldset className="personal-verdict"><legend>综合结论</legend><label>个人等级<select aria-label="个人等级" value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">暂不定级</option>{GRADE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>是否回购<select aria-label="是否回购" value={repurchase} onChange={(event) => setRepurchase(event.target.value as Repurchase | '')}><option value="">暂不判断</option>{REPURCHASE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="field-wide">一句总结<textarea aria-label="一句总结" value={summary} onChange={(event) => setSummary(event.target.value)} /></label></fieldset>
      <div className="record-actions">{initialRecord && <button type="button" className="text-button" onClick={() => { if (!dirty || window.confirm('饮用更正尚未保存，确定退出吗？')) onCancelEdit(); }}>取消更正</button>}{refreshPending && <button type="button" className="button-outline" disabled={busy} onClick={async () => { setBusy(true); setMessage(await refreshAfterSave() ? '饮用数据已刷新。' : '刷新仍未完成；已保存的饮用不会重复写入。'); setBusy(false); }}>重试刷新</button>}<button type="submit" className="button-primary" disabled={busy || refreshPending}>{busy ? '保存中…' : initialRecord ? '保存更正' : '保存饮用'}</button></div></form>}
    {message && <p className="record-message" role="status">{message}</p>}</section>;
}
