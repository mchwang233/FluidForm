import React, { useEffect, useState } from "react";
type ProviderStatus = {
  /** What the page calls it (its model package's name). */
  name?: string;
  public_status: string;
  public_error?: string | null;
  last_success_at?: string;
  official_status: string;
  official_error?: string | null;
  official_success_at?: string;
  count?: number;
  added?: number;
};
type SyncStatus = {
  /** Model research is off: nothing is looked up. */
  disabled?: boolean;
  running: boolean;
  auto_sync: boolean;
  interval_hours: number;
  last_finished_at?: string;
  next_sync_at?: string | null;
  added?: number;
  providers?: Record<string, ProviderStatus>;
  benchmarks?: {
    matched_models: number;
    sources: Record<string, { name: string; status?: string; error?: string | null; count?: number; matched_models: number; last_success_at?: string; latest_published_at?: string | null; collection_method?: string; with_details?: number;
      /** Read by itself once every ``every_days`` (its switch). */ auto?: boolean; every_days?: number;
      /** The model that read the page last, and what that cost. */ read_by?: string | null; read_cost_usd?: number | null }>;
  };
};

export function dateLabel(value?: string | null): string {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚无记录" : date.toLocaleString("zh-CN", { hour12: false });
}

export function CatalogStatus({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState<"" | "saving" | "saved">("");
  async function setAuto(auto: boolean) {
    setSaving("saving"); setError("");
    try {
      const response = await fetch(`${apiBase}/api/models/sync/leaderboard`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto }) });
      if (!response.ok) throw new Error(`保存失败（${response.status}）`);
      setStatus(await response.json()); setSaving("saved");
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败"); setSaving(""); }
  }
  useEffect(() => {
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`${apiBase}/api/models/sync`, { signal: controller.signal });
        if (!response.ok) throw new Error(`读取同步状态失败（${response.status}）`);
        const result = await response.json();
        if (!controller.signal.aborted) { setStatus(result); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取同步状态失败");
      }
    }
    poll();
    const timer = setInterval(poll, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [apiBase]);
  async function refresh() {
    setPending(true); setError("");
    try {
      const response = await fetch(`${apiBase}/api/models/sync`, { method: "POST" });
      if (!response.ok) throw new Error(`启动同步失败（${response.status}）`);
      setStatus(await response.json());
    } catch (error) { setError(error instanceof Error ? error.message : "启动同步失败"); }
    finally { setPending(false); }
  }
  if (status?.disabled) return <section className="catalog-sync" aria-label="模型目录自动更新">
    <div className="catalog-sync-heading"><div><h3>模型目录自动更新</h3><p>模型调研已停用</p></div></div>
    <p className="catalog-sync-summary" role="status">目录、价格和评分保持上次的结果；在能力里打开模型调研后恢复更新。</p>
  </section>;
  const aa = status?.benchmarks?.sources.artificial_analysis;
  const failed = Object.values(status?.providers ?? {}).some(item => item.public_status === "error")
    || Object.values(status?.benchmarks?.sources ?? {}).some(item => item.status === "error");
  return <section className="catalog-sync" aria-label="模型目录自动更新">
    <div className="catalog-sync-heading"><div><h3>模型目录自动更新</h3><p>{status ? status.auto_sync ? `每 ${status.interval_hours} 小时检查 · 启动时补查到期更新` : "自动更新已关闭，可手动更新" : "正在读取同步设置…"}</p></div><button onClick={refresh} disabled={pending || status?.running}>{pending || status?.running ? "正在更新…" : "立即更新"}</button></div>
    <p className="catalog-sync-summary" role="status">{status?.running ? "正在获取最新目录，已有模型仍可使用。" : status?.last_finished_at ? `上次检查 ${dateLabel(status.last_finished_at)} · 新增 ${status.added ?? 0} 个模型` : "首次更新完成后，将显示各家模型与同步结果。"}{status?.next_sync_at && <span>下次检查 {dateLabel(status.next_sync_at)}（应用运行期间）</span>}</p>
    {error && <p className="catalog-sync-error" role="alert">{error}</p>}
    {/* The details matter only when something failed; then they open by themselves. */}
    <details className="catalog-sync-details" open={failed || undefined}>
    <summary>各家目录与评分{failed ? " · 有更新失败" : ""}</summary>
    <div className="catalog-providers">{Object.entries(status?.providers ?? {}).map(([id, state]) => {
      const official = state.official_status;
      return <div className={`catalog-provider ${state.public_status === "error" ? "has-error" : ""}`} key={id}>
        <b>{state.name ?? id}<span>{state.count === undefined ? "—" : `${state.count} 个`}</span></b>
        <small>{state.public_status === "ok" ? "目录已更新" : state.public_status === "error" ? "更新失败，沿用上次" : "等待同步"}{official === "ok" ? " · 官方列表已核对" : official === "error" ? " · 官方列表核对失败" : ""}</small>
        {state.public_error && <p>{state.public_error}</p>}{state.official_error && <p>{state.official_error}</p>}
      </div>;
    })}{aa && <div className={`catalog-provider ${aa.status === "error" ? "has-error" : ""}`}>
        <b>Artificial Analysis<span>{aa.matched_models} 个模型有成绩</span></b>
        <small>{aa.status === "ok" ? `评分已更新 · ${dateLabel(aa.last_success_at)}` : aa.status === "error" ? "更新失败，沿用上次评分" : "等待同步"}</small>
        {aa.collection_method === "model_read" && <small>由 {aa.read_by?.split(":").pop() ?? "模型"} 读取网页{typeof aa.read_cost_usd === "number" ? ` · $${aa.read_cost_usd.toFixed(3)}` : ""}</small>}
        {aa.error && <p>{aa.error}</p>}
        <label className="catalog-auto"><span>每 {aa.every_days ?? 7} 天自动读取{saving && <small>{saving === "saving" ? "保存中…" : "已保存"}</small>}</span>
          <button type="button" role="switch" aria-checked={aa.auto !== false} aria-label="每周自动读取 Artificial Analysis"
            className={`models-switch${aa.auto !== false ? " on" : ""}`} disabled={saving === "saving"} onClick={() => setAuto(aa.auto === false)}><span /></button></label>
      </div>}</div>
    <p className="catalog-source-note">规格和参考价来自 <a href="https://models.dev/" target="_blank" rel="noreferrer">Models.dev</a>，评分来自 <a href="https://artificialanalysis.ai/leaderboards/models" target="_blank" rel="noreferrer">Artificial Analysis</a>。</p>
    </details>
  </section>;
}
