import { useEffect, useState } from 'react';
interface Props { csrfToken: string; onRecovered: () => Promise<void> }
export function RecoveryPanel({ csrfToken, onRecovered }: Props) {
  const [backups, setBackups] = useState<Array<{ name: string }>>([]); const [message, setMessage] = useState('正在读取本地备份…'); const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch('/api/recovery').then((response) => response.json()).then((body: { backups?: Array<{ name: string }> }) => { setBackups(body.backups ?? []); setMessage((body.backups?.length ?? 0) ? '请选择一份通过校验的本地备份恢复。' : '没有可用备份；请先复制 data 目录并联系维护者。'); }).catch(() => setMessage('无法读取本地恢复信息。')); }, []);
  const restore = async (name: string) => { if (!window.confirm(`恢复 ${name} 会替换当前损坏主数据，确定继续吗？`)) return; setBusy(true); try { const response = await fetch('/api/recovery/restore', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ backupName: name }) }); if (!response.ok) throw new Error(); await onRecovered(); setMessage('备份已恢复，正在重新打开本地数据。'); } catch { setMessage('恢复没有完成；原始损坏文件仍未被静默覆盖。请检查备份后重试。'); } finally { setBusy(false); } };
  return <section className="recovery-panel" aria-labelledby="recovery-title"><h2 id="recovery-title">本地数据恢复</h2><p role="status" aria-live="polite">{message}</p>{backups.map((backup) => <button key={backup.name} type="button" disabled={busy} onClick={() => void restore(backup.name)}>恢复 {backup.name}</button>)}</section>;
}
