import { useMemo, useState } from 'react';
import type { ImportConflictChoice } from '../../../domain/import-contract';
import { IMPORT_COMPRESSED_BYTES_LIMIT } from '../../../domain/import-limits';

interface PreviewConflict {
  id: string;
  beanName: string;
  field: string;
  completeValue: string;
  selectionValue: string;
  completeLocation: string;
  selectionLocation: string;
  existingValue?: string;
  availableChoices: ImportConflictChoice[];
}

interface ImportPreviewResponse {
  id: string;
  baseRevision: number;
  summary: { beans: number; brands: number; untried: number; drank: number; drinking: number; legacyScores: number };
  categories: { new: number; auto_merge: number; confirm: number; skip: number; unrecognized: number };
  conflicts: PreviewConflict[];
  unrecognized: Array<{
    beanKey: string;
    brandName: string;
    beanName: string;
    reason: 'missing_pair' | 'duplicate_complete' | 'duplicate_selection' | 'duplicate_both';
  }>;
}

interface ImportWizardProps {
  csrfToken: string;
  onCommitted: () => Promise<void>;
}

async function encodeFile(file: File) {
  if (file.size > IMPORT_COMPRESSED_BYTES_LIMIT) throw new Error(`${file.name} 超过 25MB。`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}。`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '导入发生未知错误。';
}

function importCommitButtonLabel(busy: 'preview' | 'commit' | null, unresolved: number, unresolvedItems: number) {
  if (busy === 'commit') return '正在备份并写入…';
  if (unresolved > 0) return `先处理 ${unresolved} 项冲突`;
  if (unresolvedItems > 0) return `先处理 ${unresolvedItems} 项无法识别`;
  return '确认并导入';
}

const conflictFieldLabels: Record<string, string> = {
  roastLevel: '烘焙度', process: '处理法', flavorNotes: '风味关键词', overallScoreRaw: '综合评分',
  legacyStatusRaw: '历史状态', legacyPersonalScoreRaw: '历史个人评分',
  preferenceMatchRaw: '偏好匹配', recommendationRaw: '推荐等级', referencePrice: '参考价格', pricePerGram: '元/克',
  packageGrams: '规格', originOrVariety: '产地/豆种', officialFlavorDescription: '官方风味描述',
  americanoPerformance: '美式表现', milkPerformance: '奶咖表现', suitableScenes: '适合场景', legacyNote: '历史备注',
  legacyScoreBasisRaw: '历史打分依据',
};

export function ImportWizard({ csrfToken, onCommitted }: ImportWizardProps) {
  const [complete, setComplete] = useState<File | null>(null);
  const [selection, setSelection] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ImportConflictChoice>>({});
  const [skippedBeanKeys, setSkippedBeanKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const unresolved = useMemo(
    () => preview?.conflicts.filter((conflict) => !resolutions[conflict.id]).length ?? 0,
    [preview, resolutions],
  );
  const unresolvedItems = (preview?.unrecognized.length ?? 0) - skippedBeanKeys.length;

  const invalidatePreview = () => {
    setPreview(null);
    setResolutions({});
    setSkippedBeanKeys([]);
    setMessage(null);
  };

  const previewImport = async () => {
    if (!complete || !selection) return setMessage('请同时选择完整版和选单两份 .xlsx 文件。');
    const selectedComplete = complete;
    const selectedSelection = selection;
    setBusy('preview');
    setMessage(null);
    try {
      const [encodedComplete, encodedSelection] = await Promise.all([
        encodeFile(selectedComplete),
        encodeFile(selectedSelection),
      ]);
      const response = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ complete: encodedComplete, selection: encodedSelection }),
      });
      const body = (await response.json()) as ImportPreviewResponse & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '无法生成导入预览。');
      setPreview(body);
      setResolutions({});
      setSkippedBeanKeys([]);
      setMessage('预览已生成。确认冲突后再写入，不会修改原 Excel。');
    } catch (error) {
      setPreview(null);
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const commitButtonLabel = importCommitButtonLabel(busy, unresolved, unresolvedItems);

  const commitImport = async () => {
    if (!preview || unresolved > 0 || unresolvedItems > 0) return;
    setBusy('commit');
    setMessage(null);
    try {
      const response = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ previewId: preview.id, expectedRevision: preview.baseRevision, resolutions, skippedBeanKeys }),
      });
      const body = (await response.json()) as { message?: string; alreadyImported?: boolean };
      if (!response.ok) throw new Error(body.message ?? '导入提交失败。');
      setMessage(body.alreadyImported ? '这两份文件已经导入过，数据没有重复写入。' : '导入完成，提交前备份已经保存。');
      setPreview(null);
      await onCommitted();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="import-studio" className="import-studio" aria-labelledby="import-title">
      <div className="import-intro">
        <p className="section-kicker">MIGRATION STUDIO / 02</p>
        <h2 id="import-title">接上四月的记录</h2>
        <p>先预览，再决定冲突，最后一次性写入。源表只读，空白购买计划不会生成购买记录。</p>
      </div>

      <div className="import-files">
        <label>
          <span>01 · 完整版</span>
          <input type="file" disabled={busy !== null} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setComplete(event.target.files?.[0] ?? null); invalidatePreview(); }} />
          <small>{complete?.name ?? '选择“意式咖啡豆_完整版.xlsx”'}</small>
        </label>
        <label>
          <span>02 · 选单</span>
          <input type="file" disabled={busy !== null} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setSelection(event.target.files?.[0] ?? null); invalidatePreview(); }} />
          <small>{selection?.name ?? '选择“意式咖啡豆_选单.xlsx”'}</small>
        </label>
        <button type="button" className="button-outline" disabled={busy !== null || !complete || !selection} onClick={() => void previewImport()}>
          {busy === 'preview' ? '正在安全检查…' : '生成只读预览'}
        </button>
      </div>

      {preview && (
        <div className="import-preview">
          <dl className="preview-metrics">
            <div><dt>咖啡豆</dt><dd>{preview.summary.beans}</dd></div>
            <div><dt>品牌</dt><dd>{preview.summary.brands}</dd></div>
            <div><dt>未喝 / 已喝 / 在喝</dt><dd>{preview.summary.untried} / {preview.summary.drank} / {preview.summary.drinking}</dd></div>
            <div><dt>历史评分</dt><dd>{preview.summary.legacyScores}</dd></div>
          </dl>
          <p className="category-line">新增 {preview.categories.new} · 自动合并 {preview.categories.auto_merge} · 需确认 {preview.categories.confirm} · 未识别 {preview.categories.unrecognized}</p>

          {preview.conflicts.length > 0 && (
            <div className="conflict-list" aria-labelledby="conflict-title">
              <div className="conflict-heading">
                <h3 id="conflict-title">需要你的判断</h3>
                <span>{unresolved === 0 ? '全部已处理' : `还有 ${unresolved} 项`}</span>
              </div>
              {preview.conflicts.map((conflict) => (
                <fieldset key={conflict.id}>
                  <legend>{conflict.beanName} · {conflictFieldLabels[conflict.field] ?? conflict.field}</legend>
                  {conflict.availableChoices.includes('complete') && <label><input type="radio" name={conflict.id} checked={resolutions[conflict.id] === 'complete'} onChange={() => setResolutions((current) => ({ ...current, [conflict.id]: 'complete' }))} /><span><b>{conflict.completeValue}</b><small>完整版 · {conflict.completeLocation}</small></span></label>}
                  {conflict.availableChoices.includes('selection') && <label><input type="radio" name={conflict.id} checked={resolutions[conflict.id] === 'selection'} onChange={() => setResolutions((current) => ({ ...current, [conflict.id]: 'selection' }))} /><span><b>{conflict.selectionValue}</b><small>选单 · {conflict.selectionLocation}</small></span></label>}
                  {conflict.availableChoices.includes('existing') && <label><input type="radio" name={conflict.id} checked={resolutions[conflict.id] === 'existing'} onChange={() => setResolutions((current) => ({ ...current, [conflict.id]: 'existing' }))} /><span><b>{conflict.existingValue}</b><small>保留当前看板值</small></span></label>}
                </fieldset>
              ))}
            </div>
          )}
          {preview.unrecognized.length > 0 && (
            <div className="unrecognized-list" aria-labelledby="unrecognized-title">
              <div className="conflict-heading">
                <h3 id="unrecognized-title">无法自动识别</h3>
                <span>{unresolvedItems === 0 ? '已确认跳过' : `还有 ${unresolvedItems} 项`}</span>
              </div>
              <p>请先回到 Excel 更正后重新预览，或明确确认本次跳过。</p>
              {preview.unrecognized.map((item) => (
                <label key={item.beanKey}>
                  <input
                    type="checkbox"
                    checked={skippedBeanKeys.includes(item.beanKey)}
                    onChange={(event) => setSkippedBeanKeys((current) => event.target.checked
                      ? [...current, item.beanKey]
                      : current.filter((key) => key !== item.beanKey))}
                  />
                  <span><b>{item.brandName} · {item.beanName}</b><small>{item.reason === 'missing_pair' ? '只在其中一份工作簿中出现' : '归一化后发现重复行'} · 确认跳过</small></span>
                </label>
              ))}
            </div>
          )}
          <button type="button" className="button-primary" disabled={busy !== null || unresolved > 0 || unresolvedItems > 0} onClick={() => void commitImport()}>
            {commitButtonLabel}
          </button>
        </div>
      )}
      {message && <p className="import-message" role="status">{message}</p>}
    </section>
  );
}
