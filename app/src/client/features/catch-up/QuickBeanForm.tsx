import { useState } from 'react';
import type { BrewMethod } from '../../../domain/schema';
import { formatLocalDate } from '../../local-date';

export interface QuickEntryRow {
  brandName: string;
  beanName: string;
  drankOn: string;
  brewMethod: BrewMethod;
}

interface QuickBeanFormProps {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (rows: QuickEntryRow[]) => Promise<void>;
}

function newRow(): QuickEntryRow {
  return {
    brandName: '',
    beanName: '',
    drankOn: formatLocalDate(),
    brewMethod: 'other',
  };
}

export function QuickBeanForm({ disabled, onCancel, onSubmit }: QuickBeanFormProps) {
  const [rows, setRows] = useState<QuickEntryRow[]>(() => [newRow()]);
  const [baseline, setBaseline] = useState(() => JSON.stringify(rows));
  const [error, setError] = useState('');
  const dirty = JSON.stringify(rows) !== baseline;

  const update = (index: number, field: keyof QuickEntryRow, value: string) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  };

  const clear = () => {
    if (dirty && !window.confirm('这些内容尚未保存，确定清空吗？')) return;
    const resetRows = [newRow()];
    setRows(resetRows);
    setBaseline(JSON.stringify(resetRows));
    setError('');
  };

  const cancel = () => {
    if (dirty && !window.confirm('这些内容尚未保存，确定离开快速补记吗？')) return;
    onCancel();
  };

  const submit = async () => {
    if (rows.some((row) => !row.brandName.trim() || !row.beanName.trim())) {
      setError('每一行都需要填写品牌和豆名。');
      return;
    }
    setError('');
    await onSubmit(rows);
  };

  return (
    <section className="quick-entry" aria-labelledby="quick-entry-title">
      <div className="quick-entry__heading">
        <div>
          <p className="section-kicker">QUICK MEMORY</p>
          <h3 id="quick-entry-title">先留下“喝过”这个事实</h3>
        </div>
        <button className="text-button" type="button" onClick={cancel}>返回队列</button>
      </div>
      <p>商品资料以后再补。现在只写品牌、豆名、日期与当时主要喝法。</p>
      <div className="quick-entry__rows">
        {rows.map((row, index) => (
          <fieldset key={index}>
            <legend>第 {index + 1} 款</legend>
            <label>
              <span>品牌</span>
              <input aria-label={`第 ${index + 1} 行品牌`} value={row.brandName} onChange={(event) => update(index, 'brandName', event.target.value)} />
            </label>
            <label>
              <span>豆名</span>
              <input aria-label={`第 ${index + 1} 行豆名`} value={row.beanName} onChange={(event) => update(index, 'beanName', event.target.value)} />
            </label>
            <label>
              <span>饮用日期</span>
              <input aria-label={`第 ${index + 1} 行饮用日期`} type="date" value={row.drankOn} onChange={(event) => update(index, 'drankOn', event.target.value)} />
            </label>
            <label>
              <span>主要喝法</span>
              <select aria-label={`第 ${index + 1} 行主要喝法`} value={row.brewMethod} onChange={(event) => update(index, 'brewMethod', event.target.value)}>
                <option value="americano">美式</option>
                <option value="milk">奶咖</option>
                <option value="espresso">浓缩</option>
                <option value="other">其他</option>
              </select>
            </label>
            {rows.length > 1 && <button className="row-remove" type="button" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}>移除此行</button>}
          </fieldset>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="button-outline" type="button" onClick={() => setRows((current) => [...current, newRow()])}>再加一行</button>
        <button className="text-button" type="button" onClick={clear}>清空</button>
        <button className="button-primary" type="button" disabled={disabled} onClick={() => void submit()}>批量加入待补队列</button>
      </div>
    </section>
  );
}
