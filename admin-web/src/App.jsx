import React, { useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

function Login({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setErr('');
    setLoading(true);
    try {
      const r = await api('/admin/api/login', { method: 'POST', body: { username, password } });
      setToken(r.token);
      onLogin();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>智界助手 · 管理后台</h1>
        <div className="field">
          <label>管理员账号</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        {err && <div className="err">{err}</div>}
        <button onClick={submit} disabled={loading}>{loading ? '登录中…' : '登录'}</button>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function Dashboard() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/admin/api/stats').then(setS).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="err">{err}</div>;
  if (!s) return <div>加载中…</div>;
  return (
    <div className="cards">
      <Stat label="累计用户" value={s.users_total} />
      <Stat label="今日新增" value={s.users_new_today} />
      <Stat label="付费订单" value={s.orders_paid} />
      <Stat label="累计收入(元)" value={s.revenue_yuan} />
      <Stat label="累计对话轮次" value={s.turns_total} />
      <Stat label="累计 Token" value={s.tokens_total} />
    </div>
  );
}

function Users() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [phone, setPhone] = useState('');
  const [points, setPoints] = useState('1000000');
  const [model, setModel] = useState('glm-5.1');
  const [durationDays, setDurationDays] = useState('30');
  const [created, setCreated] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = () => api('/admin/api/users').then((r) => setList(r.users)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const createTestUser = async () => {
    setErr('');
    setCreated(null);
    setCreating(true);
    try {
      const body = phone.trim() ? { phone: phone.trim() } : {};
      const quota = Number(points || 0);
      const days = Number(durationDays || 30);
      if (!Number.isSafeInteger(quota) || quota < 0) throw new Error('测试积分额度必须是非负整数');
      if (!Number.isSafeInteger(days) || days <= 0) throw new Error('有效天数必须是正整数');
      body.points = quota;
      if (quota > 0) {
        body.model = model.trim() || 'glm-5.1';
        body.duration_days = days;
      }
      const r = await api('/admin/api/test-users', { method: 'POST', body });
      setCreated(r);
      setPhone('');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setCreating(false);
    }
  };
  if (err) return <div className="err">{err}</div>;
  return (
    <div>
      <div className="panel-block">
        <div className="row">
          <div className="field inline-field">
            <label>测试手机号</label>
            <input value={phone} placeholder="留空自动生成" onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="field small-field">
            <label>测试积分额度</label>
            <input type="number" min="0" step="1000" value={points} onChange={(e) => setPoints(e.target.value)} />
          </div>
          <div className="field small-field">
            <label>模型</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div className="field tiny-field">
            <label>有效天数</label>
            <input type="number" min="1" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} />
          </div>
          <button onClick={createTestUser} disabled={creating}>{creating ? '创建中…' : '+ 添加测试用户'}</button>
        </div>
        {created && (
          <div className="notice">
            <div>已创建/刷新测试用户：{created.user.phone}，免费额度 {created.user.free_turns_remaining}/{created.user.free_turns_total} 次</div>
            {created.entitlement && (
              <div>测试积分：{created.entitlement.tokens_remaining.toLocaleString()} / {created.entitlement.token_allowance.toLocaleString()}，模型 {created.entitlement.model}，有效期至 {created.entitlement.expires_at}</div>
            )}
            <textarea readOnly value={created.token} />
          </div>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>手机号</th><th>免费额度</th><th>会员积分</th><th>对话轮次</th><th>消耗Token</th><th>充值(元)</th><th>注册时间</th><th>最近登录</th>
          </tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td><td>{u.phone}</td><td>{u.free_turns_remaining}/{u.free_turns_total}</td>
              <td>{Number(u.points_remaining || 0).toLocaleString()}</td>
              <td>{u.turns}</td><td>{u.tokens}</td><td>{u.spent_yuan}</td>
              <td>{u.created_at}</td><td>{u.last_login_at || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Orders() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/admin/api/orders').then((r) => setList(r.orders)).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="err">{err}</div>;
  return (
    <table>
      <thead>
        <tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额(元)</th><th>支付方式</th><th>状态</th><th>时间</th></tr>
      </thead>
      <tbody>
        {list.map((o) => (
          <tr key={o.out_trade_no}>
            <td>{o.out_trade_no}</td><td>{o.user_id}</td><td>{o.pkg_name}</td>
            <td>{o.amount_yuan}</td><td>{o.provider}</td>
            <td><span className={`badge ${o.status}`}>{o.status}</span></td>
            <td>{o.created_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EMPTY_PKG = {
  name: '',
  model: 'glm-5.1',
  total_tokens: 1000000,
  token_multiplier: 1,
  price_cents: 1990,
  duration_days: 30,
  active: true,
  sort_order: 0,
};

function PackageModal({ initial, onClose, onSaved }) {
  const [p, setP] = useState(initial);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setP({ ...p, [k]: v });
  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const body = {
        name: p.name, model: p.model,
        total_tokens: Number(p.total_tokens),
        token_multiplier: Number(p.token_multiplier || 1),
        price_cents: Number(p.price_cents),
        duration_days: Number(p.duration_days), active: !!p.active, sort_order: Number(p.sort_order),
      };
      if (p.id) await api(`/admin/api/packages/${p.id}`, { method: 'PUT', body });
      else await api('/admin/api/packages', { method: 'POST', body });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{p.id ? '编辑套餐' : '新建套餐'}</h2>
        <div className="field"><label>名称</label><input value={p.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label>模型</label><input value={p.model} onChange={(e) => set('model', e.target.value)} /></div>
        <div className="field"><label>积分数</label><input type="number" min="1" value={p.total_tokens} onChange={(e) => set('total_tokens', e.target.value)} /></div>
        <div className="field"><label>计费倍率</label><input type="number" min="0.01" step="0.01" value={p.token_multiplier ?? 1} onChange={(e) => set('token_multiplier', e.target.value)} /></div>
        <div className="field"><label>价格(分)</label><input type="number" value={p.price_cents} onChange={(e) => set('price_cents', e.target.value)} /></div>
        <div className="field"><label>有效天数</label><input type="number" value={p.duration_days} onChange={(e) => set('duration_days', e.target.value)} /></div>
        <div className="row">
          <label><input type="checkbox" checked={p.active} onChange={(e) => set('active', e.target.checked)} /> 上架</label>
          <div className="field" style={{ flex: 1 }}><label>排序</label><input type="number" value={p.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></div>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          <button className="ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function Packages() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const load = () => api('/admin/api/packages').then((r) => setList(r.packages)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => setEditing({ ...EMPTY_PKG })}>+ 新建套餐</button>
      </div>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr><th>ID</th><th>名称</th><th>模型</th><th>积分数</th><th>倍率</th><th>价格(元)</th><th>天数</th><th>状态</th><th></th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td><td>{p.name}</td><td>{p.model}</td><td>{p.total_tokens}</td>
              <td>{Number(p.token_multiplier || 1).toFixed(2)}x</td>
              <td>{(p.price_cents / 100).toFixed(2)}</td><td>{p.duration_days}</td>
              <td>{p.active ? '上架' : '下架'}</td>
              <td><button className="ghost" onClick={() => setEditing(p)}>编辑</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <PackageModal initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

const TABS = [
  { id: 'dashboard', label: '数据概览', comp: Dashboard },
  { id: 'users', label: '用户管理', comp: Users },
  { id: 'orders', label: '订单记录', comp: Orders },
  { id: 'packages', label: '套餐设置', comp: Packages },
];

function Shell({ onLogout }) {
  const [tab, setTab] = useState('dashboard');
  const Active = TABS.find((t) => t.id === tab).comp;
  return (
    <div className="layout">
      <div className="sidebar">
        <div className="brand">智界助手</div>
        {TABS.map((t) => (
          <div key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={onLogout}>退出登录</button>
      </div>
      <div className="main">
        <div className="topbar"><h2>{TABS.find((t) => t.id === tab).label}</h2></div>
        <Active />
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <Shell onLogout={() => { clearToken(); setAuthed(false); }} />;
}
