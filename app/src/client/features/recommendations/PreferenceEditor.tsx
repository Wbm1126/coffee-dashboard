import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PreferenceProfile } from '../../../domain/schema';
import { RECOMMENDATION_COPY as COPY } from './recommendation-copy';

interface Props {
  profile: PreferenceProfile;
  dataRevision: number;
  csrfToken: string;
  disabled: boolean;
  onDataChanged: () => Promise<void>;
}

const listText = (values: string[]) => values.join('、');
const parseList = (value: string) => [...new Set(value.split(/[、，,;；]/).map((item) => item.trim()).filter(Boolean))];
const LOCAL_REQUEST_TIMEOUT_MS = 15_000;

export function PreferenceEditor({ profile, dataRevision, csrfToken, disabled, onDataChanged }: Props) {
  const [brewMode, setBrewMode] = useState(profile.brewMode);
  const [acidityPreference, setAcidityPreference] = useState(profile.acidityPreference);
  const [roastLevels, setRoastLevels] = useState(listText(profile.roastLevels));
  const [flavorNotes, setFlavorNotes] = useState(listText(profile.flavorNotes));
  const [avoidedFlavorNotes, setAvoidedFlavorNotes] = useState(listText(profile.avoidedFlavorNotes));
  const [maxPrice, setMaxPrice] = useState(profile.maxPricePer100g?.toString() ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [priceInvalid, setPriceInvalid] = useState(false);
  const requestController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
    };
  }, []);

  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setDirty(true);
    setMessage('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const numericPrice = maxPrice.trim() === '' ? null : Number(maxPrice);
    if (numericPrice !== null && (!Number.isFinite(numericPrice) || numericPrice <= 0)) {
      setError(true); setPriceInvalid(true); setMessage(COPY.invalidBudget); return;
    }
    setSaving(true); setError(false); setPriceInvalid(false); setMessage('');
    const controller = new AbortController();
    requestController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch('/api/recommendations/preferences', {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        signal: controller.signal,
        body: JSON.stringify({ expectedRevision: dataRevision, brewMode, acidityPreference,
          roastLevels: parseList(roastLevels), flavorNotes: parseList(flavorNotes),
          avoidedFlavorNotes: parseList(avoidedFlavorNotes), maxPricePer100g: numericPrice }),
      });
      if (!mounted.current) return;
      let body: { message?: string } | null = null;
      try { body = await response.json() as { message?: string }; } catch { /* handled as an ambiguous result below */ }
      if (response.ok && body === null) {
        setError(true);
        try {
          await onDataChanged();
          setMessage(COPY.malformedPreferenceReconciled);
        } catch {
          setMessage(COPY.malformedPreferenceUnreconciled);
        }
        return;
      }
      if (!response.ok) {
        setError(true);
        setMessage(body?.message ?? COPY.preferenceRejected);
        return;
      }
      setDirty(false);
      try {
        await onDataChanged();
        setMessage(COPY.preferenceSaved);
      } catch {
        setError(true);
        setMessage(COPY.preferenceSavedViewFailed);
      }
    } catch {
      if (!mounted.current) return;
      setError(true);
      try {
        await onDataChanged();
        setMessage(COPY.preferenceInterruptedReconciled);
      } catch {
        setMessage(COPY.preferenceInterruptedUnreconciled);
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestController.current === controller) requestController.current = null;
      if (mounted.current) setSaving(false);
    }
  };

  return <form className="preference-sheet" onSubmit={(event) => void save(event)}>
    <div className="preference-sheet__heading"><span>01</span><div><h3>我的选豆偏好</h3><p>显式偏好只影响排序，不会改写商品事实或个人评价。</p></div></div>
    <div className="preference-fields">
      <label>主要冲煮方式<select aria-label="主要冲煮方式" value={brewMode} disabled={disabled || saving} onChange={(event) => change(setBrewMode, event.target.value as PreferenceProfile['brewMode'])}><option value="balanced">美式与奶咖兼顾</option><option value="americano">主要喝美式</option><option value="milk">主要喝奶咖</option></select></label>
      <label>酸感偏好<select aria-label="酸感偏好" value={acidityPreference} disabled={disabled || saving} onChange={(event) => change(setAcidityPreference, event.target.value as PreferenceProfile['acidityPreference'])}><option value="any">不限定</option><option value="low">偏好低酸</option><option value="medium">偏好中等酸感</option><option value="high">偏好明亮酸感</option></select></label>
      <label>喜欢的烘焙度<input value={roastLevels} disabled={disabled || saving} onChange={(event) => change(setRoastLevels, event.target.value)} placeholder="例如：中烘焙、中深烘焙" /></label>
      <label>喜欢的风味<input value={flavorNotes} disabled={disabled || saving} onChange={(event) => change(setFlavorNotes, event.target.value)} placeholder="例如：巧克力、坚果" /></label>
      <label>想避开的风味<input value={avoidedFlavorNotes} disabled={disabled || saving} onChange={(event) => change(setAvoidedFlavorNotes, event.target.value)} placeholder="例如：烟熏、发酵感" /></label>
      <label>每 100g 最高预算<input type="number" min="0.01" step="0.01" inputMode="decimal" value={maxPrice} disabled={disabled || saving} aria-invalid={priceInvalid || undefined} aria-describedby={priceInvalid ? 'preference-save-message' : undefined} onChange={(event) => { setPriceInvalid(false); change(setMaxPrice, event.target.value); }} placeholder="未知时留空" /></label>
    </div>
    {message && <p id="preference-save-message" className={`recommendation-message ${error ? 'recommendation-message--error' : ''}`} role="status" aria-live="polite">{message}</p>}
    <button type="submit" className="button-primary" disabled={disabled || saving || !dirty}>{saving ? '保存中…' : '保存偏好'}</button>
  </form>;
}
