import { useState, type FormEvent } from 'react';

interface Props { csrfToken: string; open: boolean; onClose: () => void; onAuthenticated: (username: string) => void }

// U9 管理员登录弹窗：成功后由服务端下发 HttpOnly 会话 Cookie。
export function LoginDialog({ csrfToken, open, onClose, onAuthenticated }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json() as { authenticated?: boolean; username?: string; message?: string };
      if (!response.ok || !body.authenticated) {
        setMessage(body.message ?? '登录失败，请重试。');
        return;
      }
      setUsername(''); setPassword('');
      onAuthenticated(body.username ?? 'admin');
    } catch {
      setMessage('登录请求失败，请检查本地服务。');
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-backdrop" role="presentation" onClick={onClose}>
    <form className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()}>
      <h3 id="login-title">管理员登录</h3>
      <p>访客可浏览全部内容；登录后才能记录与修改。</p>
      <label>账号<input aria-label="管理员账号" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>密码<input aria-label="管理员密码" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <div className="login-actions">
        <button type="button" className="text-button" onClick={onClose}>取消</button>
        <button type="submit" className="button-primary" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </div>
      {message && <p className="login-message" role="alert">{message}</p>}
    </form>
  </div>;
}
