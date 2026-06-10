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
        <h1>DeskAgent 桌面助手 · 管理后台</h1>
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

function useAdminModels() {
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('/admin/api/models')
    .then((r) => {
      setModels(Array.isArray(r.models) ? r.models : []);
      setDefaultModel(r.default_model || (r.models && r.models[0] && r.models[0].id) || '');
      return r;
    })
    .catch((e) => {
      setErr(e.message);
      throw e;
    });
  useEffect(() => {
    load().catch(() => {});
  }, []);
  return { models, setModels, defaultModel, err, setErr, load };
}

function modelName(model) {
  return model?.display_name || model?.name || model?.id || '';
}

function modelSummary(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  return list.length ? list.join(', ') : '-';
}

function formatPoints(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

function ModelCheckboxes({ models, value, onChange, disabled }) {
  const selected = new Set(Array.isArray(value) ? value : []);
  const fallbackId = value && value[0] ? value[0] : 'glm-5.1';
  const options = models.length ? models : [{ id: fallbackId, display_name: fallbackId, configured: true }];
  return (
    <div className="model-checks">
      {options.map((model) => (
        <label key={model.id} className={model.configured === false ? 'disabled' : ''}>
          <input
            type="checkbox"
            disabled={disabled || model.configured === false}
            checked={selected.has(model.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(model.id);
              else next.delete(model.id);
              onChange(Array.from(next));
            }}
          />
          <span>{modelName(model)}{model.configured === false ? '（未配置密钥）' : ''}</span>
          {model.point_multiplier ? <em>{Number(model.point_multiplier).toFixed(2)} 积分/百万 token</em> : null}
        </label>
      ))}
    </div>
  );
}

function EntitlementSummary({ user }) {
  const items = (user.entitlements || []).filter((item) => Number(item.points_remaining || 0) > 0);
  if (!items.length) return <span className="muted">-</span>;
  return (
    <div className="entitlements">
      {items.map((item) => (
        <div key={item.id || item.model}>
          <span>{modelSummary(item.models || [item.model])}</span>
          <strong>{formatPoints(item.points_remaining)}</strong>
        </div>
      ))}
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
      <Stat label="累计消耗积分" value={formatPoints(s.points_used_total)} />
      <Stat label="累计模型 Token" value={s.tokens_total} />
    </div>
  );
}

function Users() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [phone, setPhone] = useState('');
  const [points, setPoints] = useState('100');
  const [selectedModels, setSelectedModels] = useState([]);
  const [durationDays, setDurationDays] = useState('30');
  const [created, setCreated] = useState(null);
  const [creating, setCreating] = useState(false);
  const { models, defaultModel, err: modelsErr } = useAdminModels();
  const load = () => api('/admin/api/users').then((r) => setList(r.users)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!selectedModels.length && defaultModel) setSelectedModels([defaultModel]);
  }, [selectedModels.length, defaultModel]);
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
        body.models = selectedModels.length ? selectedModels : [defaultModel || (models[0] && models[0].id) || 'glm-5.1'];
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
            <input type="number" min="0" step="1" value={points} onChange={(e) => setPoints(e.target.value)} />
          </div>
          <div className="field model-field">
            <label>可用模型</label>
            <ModelCheckboxes models={models} value={selectedModels} onChange={setSelectedModels} disabled={creating} />
          </div>
          <div className="field tiny-field">
            <label>有效天数</label>
            <input type="number" min="1" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} />
          </div>
          <button onClick={createTestUser} disabled={creating}>{creating ? '创建中…' : '+ 添加测试用户'}</button>
        </div>
        {modelsErr && <div className="err">模型列表加载失败：{modelsErr}</div>}
        {created && (
          <div className="notice">
            <div>已创建/刷新测试用户：{created.user.phone}</div>
            {created.entitlement && (
              <div>测试积分：{formatPoints(created.entitlement.points_remaining)} / {formatPoints(created.entitlement.points)}，模型 {modelSummary(created.entitlement.models)}，有效期至 {created.entitlement.expires_at}</div>
            )}
            <textarea readOnly value={created.token} />
          </div>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>手机号</th><th>积分余额</th><th>可用模型额度</th><th>模型Token</th><th>消耗积分</th><th>充值(元)</th><th>注册时间</th><th>最近登录</th>
          </tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td><td>{u.phone}</td>
              <td>{formatPoints(u.points_remaining)}</td>
              <td><EntitlementSummary user={u} /></td>
              <td>{u.tokens}</td><td>{formatPoints(u.points_used)}</td><td>{u.spent_yuan}</td>
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
  models: ['glm-5.1'],
  points: 1990,
  price_cents: 1990,
  duration_days: 30,
  active: true,
  sort_order: 0,
};

function PackageModal({ initial, models, defaultModel, onClose, onSaved }) {
  const [p, setP] = useState(initial);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if ((!p.models || !p.models.length) && defaultModel) setP((prev) => ({ ...prev, models: [defaultModel] }));
  }, [p.models, defaultModel]);
  const set = (k, v) => setP({ ...p, [k]: v });
  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const points = Number(p.points || p.total_tokens);
      const priceCents = Number(p.price_cents);
      const durationDays = Number(p.duration_days);
      const sortOrder = Number(p.sort_order);
      if (!Number.isSafeInteger(points) || points <= 0) throw new Error('套餐积分数必须是正整数');
      if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error('价格必须是非负整数分');
      if (!Number.isSafeInteger(durationDays) || durationDays <= 0) throw new Error('有效天数必须是正整数');
      if (!Number.isSafeInteger(sortOrder)) throw new Error('排序必须是整数');
      const body = {
        name: p.name,
        models: Array.isArray(p.models) && p.models.length ? p.models : [defaultModel || (models[0] && models[0].id) || 'glm-5.1'],
        points,
        price_cents: priceCents,
        duration_days: durationDays, active: !!p.active, sort_order: sortOrder,
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
        <div className="field"><label>可用模型</label><ModelCheckboxes models={models} value={p.models || [p.model || defaultModel]} onChange={(value) => set('models', value)} /></div>
        <div className="field"><label>积分数（1 元 = 100 积分，价格分值通常等于积分数）</label><input type="number" min="1" step="1" value={p.points || p.total_tokens} onChange={(e) => set('points', e.target.value)} /></div>
        <div className="field"><label>价格(分)</label><input type="number" min="0" step="1" value={p.price_cents} onChange={(e) => set('price_cents', e.target.value)} /></div>
        <div className="field"><label>有效天数</label><input type="number" min="1" step="1" value={p.duration_days} onChange={(e) => set('duration_days', e.target.value)} /></div>
        <div className="row">
          <label><input type="checkbox" checked={p.active} onChange={(e) => set('active', e.target.checked)} /> 上架</label>
          <div className="field" style={{ flex: 1 }}><label>排序</label><input type="number" step="1" value={p.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></div>
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
  const { models, defaultModel, err: modelsErr } = useAdminModels();
  const load = () => api('/admin/api/packages').then((r) => setList(r.packages)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => setEditing({ ...EMPTY_PKG, models: [defaultModel || EMPTY_PKG.models[0]] })}>+ 新建套餐</button>
      </div>
      {modelsErr && <div className="err">模型列表加载失败：{modelsErr}</div>}
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr><th>ID</th><th>名称</th><th>可用模型</th><th>积分数</th><th>价格(元)</th><th>天数</th><th>状态</th><th></th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td><td>{p.name}</td><td>{modelSummary(p.models || [p.model])}</td><td>{formatPoints(p.points || p.total_tokens)}</td>
              <td>{(p.price_cents / 100).toFixed(2)}</td><td>{p.duration_days}</td>
              <td>{p.active ? '上架' : '下架'}</td>
              <td><button className="ghost" onClick={() => setEditing(p)}>编辑</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <PackageModal initial={editing} models={models} defaultModel={defaultModel} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function ModelPricing() {
  const { models, setModels, err, setErr, load } = useAdminModels();
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!models.length) return;
    setValues((prev) => {
      const next = { ...prev };
      models.forEach((model) => {
        if (next[model.id] == null) next[model.id] = String(model.point_multiplier || 1);
      });
      return next;
    });
  }, [models]);

  const setMultiplier = (id, value) => {
    setNotice('');
    setValues((prev) => ({ ...prev, [id]: value }));
  };

  const save = async () => {
    setErr('');
    setNotice('');
    setSaving(true);
    try {
      const body = {
        models: models.map((model) => {
          const multiplier = Number(values[model.id]);
          if (!Number.isFinite(multiplier) || multiplier <= 0) {
            throw new Error(`${modelName(model)} 的积分倍率必须大于 0`);
          }
          return { id: model.id, point_multiplier: multiplier };
        }),
      };
      const r = await api('/admin/api/models', { method: 'PUT', body });
      const nextModels = Array.isArray(r.models) ? r.models : [];
      setModels(nextModels);
      setValues(Object.fromEntries(nextModels.map((model) => [model.id, String(model.point_multiplier || 1)])));
      setNotice('模型积分倍率已保存并立即生效');
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const resetFromServer = async () => {
    setErr('');
    setNotice('');
    try {
      const r = await load();
      const nextModels = Array.isArray(r.models) ? r.models : [];
      setValues(Object.fromEntries(nextModels.map((model) => [model.id, String(model.point_multiplier || 1)])));
    } catch (_) {}
  };

  return (
    <div>
      <div className="panel-block">
        <div className="model-pricing-head">
          <div>
            <h3>模型积分消耗比例</h3>
            <p>1x 表示 100 万模型 token 消耗 1 积分；服务端按 6 位精度扣费，客户端和管理端按整数积分展示。</p>
          </div>
          <div className="row">
            <button onClick={save} disabled={saving || !models.length}>{saving ? '保存中…' : '保存倍率'}</button>
            <button className="ghost" onClick={resetFromServer} disabled={saving}>刷新</button>
          </div>
        </div>
        {notice && <div className="notice">{notice}</div>}
        {err && <div className="err">{err}</div>}
      </div>
      <table>
        <thead>
          <tr>
            <th>模型</th><th>Provider</th><th>配置状态</th><th>默认倍率</th><th>当前积分/百万 token</th><th>来源</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id}>
              <td><strong>{modelName(model)}</strong><div className="muted">{model.id}</div></td>
              <td>{model.provider}</td>
              <td>{model.configured ? '已配置' : '未配置密钥'}</td>
              <td>{Number(model.default_point_multiplier || model.point_multiplier || 1).toFixed(2)}</td>
              <td>
                <input
                  className="pricing-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={values[model.id] ?? ''}
                  onChange={(e) => setMultiplier(model.id, e.target.value)}
                />
              </td>
              <td>{model.pricing_overridden ? '管理端覆盖' : '默认配置'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [
  { id: 'dashboard', label: '数据概览', comp: Dashboard },
  { id: 'users', label: '用户管理', comp: Users },
  { id: 'orders', label: '订单记录', comp: Orders },
  { id: 'packages', label: '套餐设置', comp: Packages },
  { id: 'models', label: '模型计费', comp: ModelPricing },
];

function Shell({ onLogout }) {
  const [tab, setTab] = useState('dashboard');
  const Active = TABS.find((t) => t.id === tab).comp;
  return (
    <div className="layout">
      <div className="sidebar">
        <div className="brand">DeskAgent 管理后台</div>
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
