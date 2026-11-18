import React, { FormEvent, useEffect, useState } from "react";
import { Icon } from "./icons";
import { detailText } from "./mission-history";

/** The Feishu bot (docs/design/feishu.md): its state, credentials, switch and daily budget. */
type Status = {
  available: boolean; installed: boolean; configured: boolean; enabled: boolean; status: string; error: string;
  daily_budget_usd: number; spent_today_usd: number; handled: number; conversations: number;
};

const STATE: Record<string, { label: string; tone: string }> = {
  connected: { label: "已连接", tone: "ok" }, connecting: { label: "连接中", tone: "busy" },
  error: { label: "出错了", tone: "bad" }, off: { label: "没开", tone: "muted" },
};

export function FeishuPanel({ apiBase, onClose }: { apiBase: string; onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState(""), [secret, setSecret] = useState(""), [budget, setBudget] = useState("");
  async function call(path: string, init?: RequestInit) {
    const response = await fetch(`${apiBase}/api/feishu${path}`, init);
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(detailText(body.detail) || `操作失败（${response.status}）`);
    return body as Status;
  }
  const load = () => call("").then(body => { if (body) { setStatus(body); setBudget(current => current || String(body.daily_budget_usd)); } }).catch(failure => setError(failure.message));
  useEffect(() => { void load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [apiBase]);
  useEffect(() => { const keys = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys); }, []);
  async function act(path: string, init: RequestInit) {
    setBusy(true); setError("");
    try { const body = await call(path, init); if (body) setStatus(body); else await load(); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setBusy(false); }
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await act("/credentials", json("PUT", { app_id: appId.trim(), app_secret: secret.trim() }))) { setAppId(""); setSecret(""); }
  }
  const state = status ? STATE[status.enabled ? status.status : "off"] ?? STATE.off : null;
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="feishu-panel" role="dialog" aria-modal="true" aria-label="飞书机器人">
      <div className="feishu-head"><h3>飞书机器人</h3><button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>×</button></div>
      <p className="feishu-lead">在飞书里私聊它，或在群里 @ 它：问题直接回答；要动手的事在搭子里排好计划，你确认后才开工，做完把结果发回飞书。</p>
      {!status ? <p className="muted">正在读取…</p> : <>
        <div className="feishu-state">
          <span className={`dx-chip ${state!.tone}`}>{state!.tone === "busy" && <i className="pulse" aria-hidden="true" />}{state!.label}</span>
          <span className="feishu-counts">今天花了 ${status.spent_today_usd.toFixed(2)} · 已回 {status.handled} 条 · {status.conversations} 段对话</span>
          <button type="button" role="switch" aria-checked={status.enabled} aria-label={status.enabled ? "关掉飞书机器人" : "打开飞书机器人"}
            className={`models-switch${status.enabled ? " on" : ""}`} disabled={busy || (!status.enabled && !(status.available && status.installed && status.configured))}
            onClick={() => act("", json("PUT", { enabled: !status.enabled }))}><span /></button>
        </div>
        {!status.available && <p className="feishu-note">本机还没开启这个功能：在 .env 里加一行 <code>SUPER_PARTNER_FEISHU_BOT=true</code>，重启服务后再来。</p>}
        {status.available && !status.installed && <p className="feishu-note">还没安装飞书 SDK：<code>pip install 'super-partner[feishu]'</code></p>}
        {status.enabled && status.error && <p className="error" role="alert">{status.error}</p>}
        <form className="feishu-form" onSubmit={save} aria-label="飞书应用凭证">
          <label>App ID<input value={appId} onChange={event => setAppId(event.target.value)} placeholder={status.configured ? "已保存，要换才填" : "cli_ 开头"} autoComplete="off" /></label>
          <label>App Secret<input type="password" value={secret} onChange={event => setSecret(event.target.value)} placeholder={status.configured ? "已保存，要换才填" : ""} autoComplete="new-password" /></label>
          <div className="feishu-form-bar">
            <small className="muted">存在系统钥匙串里，不写进任何文件。</small>
            {status.configured && <button type="button" className="link-button" disabled={busy} onClick={() => act("/credentials", { method: "DELETE" })}>移除</button>}
            <button type="submit" className="primary" disabled={busy || appId.trim().length < 4 || secret.trim().length < 8}>{status.configured ? "更换" : "保存"}</button>
          </div>
        </form>
        <label className="feishu-budget">每天最多花 <span>$</span><input type="number" min="0" step="any" inputMode="decimal" aria-label="每天最多花（美元）" value={budget}
          onChange={event => setBudget(event.target.value)}
          onBlur={() => { const value = Number(budget); if (value >= 0 && value !== status.daily_budget_usd) void act("", json("PUT", { daily_budget_usd: value })); }} />
          <small className="muted">判断和回答的花费；排好的任务按你确认的预算另算。</small></label>
        <details className="models-fold feishu-howto"><summary>在飞书开放平台怎么设置</summary><ol>
          <li>在飞书开放平台创建企业自建应用，打开「机器人」能力。</li>
          <li>「事件与回调」里选「使用长连接接收事件」，添加事件「接收消息 v2.0」（im.message.receive_v1）。</li>
          <li>权限里开通：读取用户发给机器人的单聊消息、获取群组中 @ 机器人的消息、以机器人身份发消息。</li>
          <li>发布应用版本，把 App ID 和 App Secret 填到上面，再打开开关。</li>
        </ol></details>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </div>;
}

export function FeishuMenuItem({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="settings-link" onClick={onOpen}><Icon name="chat" size={14} />飞书机器人</button>;
}
