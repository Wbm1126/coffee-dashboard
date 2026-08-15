import { useEffect, useState } from 'react';
import type { CatchUpQueueItem } from '../../../domain/review-completeness';
import { createUnreviewedReview } from '../../../domain/review-defaults';
import type { BrewMethod, Repurchase, Review } from '../../../domain/schema';
import { formatLocalDate } from '../../local-date';
import { BREW_METHOD_OPTIONS, GRADE_OPTIONS, REPURCHASE_OPTIONS, REVIEW_SCORE_OPTIONS, REVIEW_STATE_OPTIONS } from './review-options';

type ReviewState = Review['state'];

export interface ReviewSavePayload {
  beanId: string;
  drinkingRecordId: string | null;
  drankOn: string;
  brewMethod: BrewMethod;
  extractionNote: string | null;
  feeling: string | null;
  americanoReview: Review;
  milkReview: Review;
  isDraft: boolean;
  assessment: { grade: string | null; repurchase: Repurchase | null; summary: string | null } | null;
}

interface ReviewEditorProps {
  item: CatchUpQueueItem;
  disabled: boolean;
  onSave: (payload: ReviewSavePayload) => Promise<boolean>;
  onLater: () => void;
  onSkip: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

function DimensionEditor({ label, review, onChange }: { label: '美式' | '奶咖'; review: Review; onChange: (review: Review) => void }) {
  const prefix = label === '美式' ? 'americano' : 'milk';
  const setState = (state: ReviewState) => onChange({ ...review, state, score: state === 'reviewed' ? review.score : null });
  return (
    <fieldset className={`review-lane review-lane--${prefix}`}>
      <legend>{label}</legend>
      <div className="dimension-state" aria-label={`${label}评价状态`}>
        {REVIEW_STATE_OPTIONS.map((option) => (
          <label key={option.value}>
            <input type="radio" name={`${prefix}-state`} checked={review.state === option.value} onChange={() => setState(option.value)} aria-label={`${label}${option.label}`} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {review.state === 'reviewed' && (
        <div className="review-fields">
          <label>
            <span>评分</span>
            <select aria-label={`${label}评分`} value={review.score ?? ''} onChange={(event) => onChange({ ...review, score: event.target.value ? Number(event.target.value) : null })}>
              <option value="">请选择</option>
              {REVIEW_SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}
            </select>
          </label>
          <label className="field-wide">
            <span>风味标签</span>
            <input aria-label={`${label}风味标签`} value={review.flavorNotes.join('、')} placeholder="例如：榛果、焦糖" onChange={(event) => onChange({ ...review, flavorNotes: event.target.value.split(/[、，,]/).map((value) => value.trim()).filter(Boolean) })} />
          </label>
          <label>
            <span>优点</span>
            <textarea aria-label={`${label}优点`} rows={3} value={review.pros ?? ''} onChange={(event) => onChange({ ...review, pros: event.target.value || null })} />
          </label>
          <label>
            <span>不足</span>
            <textarea aria-label={`${label}不足`} rows={3} value={review.cons ?? ''} onChange={(event) => onChange({ ...review, cons: event.target.value || null })} />
          </label>
          <label className="field-wide">
            <span>补充品鉴</span>
            <textarea aria-label={`${label}补充品鉴`} rows={3} value={review.note ?? ''} onChange={(event) => onChange({ ...review, note: event.target.value || null })} />
          </label>
        </div>
      )}
    </fieldset>
  );
}

export function ReviewEditor({ item, disabled, onSave, onLater, onSkip, onDirtyChange }: ReviewEditorProps) {
  const [drankOn, setDrankOn] = useState(item.drankOn ?? formatLocalDate());
  const [brewMethod, setBrewMethod] = useState<ReviewSavePayload['brewMethod']>(item.brewMethod ?? 'other');
  const [extractionNote, setExtractionNote] = useState(item.extractionNote ?? '');
  const [feeling, setFeeling] = useState(item.feeling ?? '');
  const [americanoReview, setAmericanoReview] = useState<Review>(item.americanoReview ?? createUnreviewedReview());
  const [milkReview, setMilkReview] = useState<Review>(item.milkReview ?? createUnreviewedReview());
  const [grade, setGrade] = useState(item.assessment?.grade ?? '');
  const [repurchase, setRepurchase] = useState(item.assessment?.repurchase ?? '');
  const [summary, setSummary] = useState(item.assessment?.summary ?? '');
  const [error, setError] = useState('');
  const snapshot = JSON.stringify({ drankOn, brewMethod, extractionNote, feeling, americanoReview, milkReview, grade, repurchase, summary });
  const [baseline, setBaseline] = useState(snapshot);
  const dirty = snapshot !== baseline;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const save = async (isDraft: boolean) => {
    if (!isDraft) {
      if (americanoReview.state === 'reviewed' && americanoReview.score === null) return setError('请为已评价的美式选择评分。');
      if (milkReview.state === 'reviewed' && milkReview.score === null) return setError('请为已评价的奶咖选择评分。');
    }
    setError('');
    const assessmentRepurchase = repurchase === 'yes' || repurchase === 'price_dependent' || repurchase === 'no'
      ? repurchase
      : null;
    const saved = await onSave({
      beanId: item.beanId,
      drinkingRecordId: item.drinkingRecordId,
      drankOn,
      brewMethod,
      extractionNote: extractionNote || null,
      feeling: feeling || null,
      americanoReview,
      milkReview,
      isDraft,
      assessment: {
        grade: grade || null,
        repurchase: assessmentRepurchase,
        summary: summary || null,
      },
    });
    if (saved) setBaseline(snapshot);
  };

  return (
    <form className="review-editor" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <div className="review-editor__bean">
        <p>{item.brandName ?? '未记录品牌'}</p>
        <h3>{item.beanName}</h3>
        <span>{item.reason === 'legacy_without_drinking_record' ? '来自四月表格 · 等你补上真实饮用日期' : item.reason === 'draft_drinking_record' ? '上次保存的草稿' : '已有饮用记录 · 评价未完成'}</span>
      </div>

      <fieldset className="drink-facts">
        <legend>这一次怎么喝</legend>
        <label><span>饮用日期</span><input type="date" value={drankOn} onChange={(event) => setDrankOn(event.target.value)} required /></label>
        <label><span>主要喝法</span><select value={brewMethod} onChange={(event) => setBrewMethod(event.target.value as ReviewSavePayload['brewMethod'])}>{BREW_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>萃取记录</span><input value={extractionNote} onChange={(event) => setExtractionNote(event.target.value)} placeholder="粉量、液重、时间…" /></label>
        <label><span>当时感受</span><textarea rows={2} value={feeling} onChange={(event) => setFeeling(event.target.value)} /></label>
      </fieldset>

      <div className="tasting-flight" aria-label="双轨品鉴记录">
        <div className="flight-spine" aria-hidden="true"><span>一支豆</span><i /><span>两种喝法</span></div>
        <DimensionEditor label="美式" review={americanoReview} onChange={setAmericanoReview} />
        <DimensionEditor label="奶咖" review={milkReview} onChange={setMilkReview} />
      </div>

      <fieldset className="personal-verdict">
        <legend>最后由你定调</legend>
        <label><span>个人等级</span><select aria-label="个人等级" value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">暂不定级</option>{GRADE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>是否回购</span><select aria-label="是否回购" value={repurchase} onChange={(event) => setRepurchase(event.target.value)}><option value="">暂不判断</option>{REPURCHASE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="field-wide"><span>一句总结</span><textarea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      </fieldset>

      {error && <p className="form-error">{error}</p>}
      <div className="review-actions">
        <button className="text-button" type="button" onClick={onSkip}>跳过本轮</button>
        <button className="text-button" type="button" onClick={onLater}>稍后</button>
        <button className="button-outline" type="button" disabled={disabled} onClick={() => void save(true)}>保存草稿</button>
        <button className="button-primary" type="submit" disabled={disabled}>保存并继续</button>
      </div>
    </form>
  );
}
