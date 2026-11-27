import React, { FormEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { capabilitiesChanged } from "./provided";
import { Markdown as MarkdownView } from "./markdown";

/** Capabilities: what finished tasks left the platform able to do (docs/design/capabilities.md).
 * The shelf on the platform engineer page lists them; a task's result page offers its lead's
 * proposals to solidify. */
export type CapabilityCard = {
  name: string; kind: string; summary: string; usage: string; guide?: string; files: string[]; check: string;
  secrets: string[]; domains: string[];
};
export type Capability = CapabilityCard & {
  id: string; status: "active" | "disabled" | "failed"; source_run_id?: string | null;
  check_ok?: boolean | null; check_output: string; created_at: string;
  source?: "task" | "upload"; version?: string; entry?: string;
  // A service package: the capabilities it gives FluidForm itself; any package: what it needs first.
  provides?: string[]; requires?: string[];
  // An interface package: the web page FluidForm serves at /<id>/.
  site?: string;
};
export type CapabilityProposal = CapabilityCard & { status: "proposed" | "solidified" | "dismissed"; capability_id?: string | null };
/** An uploaded package's secrets stored, and an automation's state (server: capability-runner.ts). */
type Runtime = {
  secrets: Record<string, boolean>; status?: string; text?: string; error?: string; log?: string[];
  spent_today_usd?: number; handled?: number; conversations?: number;
  model_id?: string | null;
};
type Runtimes = { available: boolean; missing: string; capabilities: Record<string, Runtime> };

const KIND: Record<string, string> = { tool: "工具", automation: "自动化", service: "服务", interface: "界面", extension: "扩展" };
// The capabilities FluidForm itself uses, as the page names them (server: service-names.ts).
const PROVIDED: Record<string, string> = { chat: "聊天", pricing: "计价", planning: "规划", team: "员工", lead: "负责人", review: "验收",
  diagnosis: "诊断", engineer: "平台工程师", learning: "复盘与经验", preflight: "执行前检查", skills: "技能", research: "模型调研" };
// A model package provides its models: "model:cli:agy" reads 模型 agy, "model:api:kimi" 模型 kimi.
const named = (names: string[] = []) => names.map(name => PROVIDED[name] ?? (/^model:(cli|api):/.test(name) ? `模型 ${name.split(":")[2]}` : name)).join("、");
const STATUS: Record<Capability["status"], string> = { active: "可用", disabled: "已停用", failed: "检查未通过" };
const RUNNING: Record<string, { label: string; tone: string }> = {
  running: { label: "运行中", tone: "ok" }, starting: { label: "启动中", tone: "busy" }, restarting: { label: "重启中", tone: "busy" },
  error: { label: "出错了", tone: "bad" }, off: { label: "没运行", tone: "muted" },
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `请求失败（${response.status}）`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const sendJson = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** 平台工程师 → 能力: every capability on this machine; packages are uploaded and uninstalled here
 * (docs/design/capability-packages.md). */
export function CapabilityShelf({ apiBase, runs, onOpenRun }: {
  apiBase: string; runs: { id: string; plan: { summary: string; title?: string } }[]; onOpenRun: (id: string) => void;
}) {
  const [items, setItems] = useState<Capability[] | null>(null), [error, setError] = useState(""), [removing, setRemoving] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Runtimes | null>(null), [confirming, setConfirming] = useState<string | null>(null), [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const base = `${apiBase}/api/capabilities`, one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const loadRuntime = () => call<Runtimes>(`${base}/runtime`).then(setRuntime).catch(() => undefined);
  const load = () => Promise.all([call<Capability[]>(base).then(setItems), loadRuntime()]).catch(failure => setError(failure.message));
  useEffect(() => { void load(); }, [apiBase]);
  const packaged = !!items?.some(item => item.source === "upload");
  useEffect(() => { if (!packaged) return; const timer = setInterval(loadRuntime, 3000); return () => clearInterval(timer); }, [apiBase, packaged]);
  async function act(promise: Promise<unknown>) {
    setError("");
    try { await promise; capabilitiesChanged(); await load(); return true; } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    await act(call(`${base}/upload`, { method: "POST", headers: { "content-type": "application/zip" }, body: file }));
    setUploading(false);
    if (picker.current) picker.current.value = "";
  }
  const source = (id?: string | null) => runs.find(run => run.id === id);
  return <section className="panel capability-shelf" aria-label="能力">
    <h3>能力{!!items?.length && <small>{items.length}</small>}</h3>
    <p className="muted">任务做出来、你固化下来的工具和自动化，以及你上传的能力包。可用的工具会告诉之后的每个任务，让它们直接用。</p>
    <div className="capability-toolbar">
      <button type="button" className="ghost" disabled={uploading || runtime?.available === false} onClick={() => picker.current?.click()}>
        <Icon name="plus" size={14} />{uploading ? "正在安装…" : "上传能力包"}</button>
      <input ref={picker} type="file" accept=".zip,application/zip" hidden aria-label="能力包" onChange={event => void upload(event.target.files?.[0])} />
      <small className="muted">{runtime?.available === false
        ? <>本机还没开启能力包：在 .env 里加 <code>FLUIDFORM_CAPABILITY_PACKAGES=true</code> 后重启。</>
        : uploading ? "解包、装依赖、跑检查，可能要几分钟。" : runtime?.missing || "一个 zip：capability.json、代码、可选的 SKILL.md 和 requirements.txt。"}</small>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {items && !items.length && <p className="empty">还没有能力。任务完成后，负责人会提议它做出的可复用工具，你在结果页一键固化；也可以上传能力包。</p>}
    <ul className="capability-list">{(items ?? []).map(item => {
      const uploaded = item.source === "upload" && item.kind !== "extension", state = runtime?.capabilities[item.id];
      const lacking = item.secrets.filter(name => uploaded && state && !state.secrets[name]);
      const enable = () => uploaded && item.status !== "active" ? setConfirming(item.id)
        : act(call(one(item.id), sendJson("PATCH", { enabled: item.status !== "active", ...(item.kind === "extension" && { confirmed: true }) })));
      return <li key={item.id} className={`capability ${item.status}`}>
        <div className="capability-head">
          <Icon name={item.kind === "automation" ? "activity" : item.kind === "service" ? "cpu" : item.kind === "interface" ? "monitor" : "wrench"} size={15} />
          <b>{item.name}</b>
          <span className="capability-kind">{KIND[item.kind] ?? item.kind}{(uploaded || item.kind === "extension") && ` · 能力包${item.version ? ` v${item.version}` : ""}`}</span>
          <span className={`capability-status ${item.status}`}>{STATUS[item.status]}</span>
          <span className="capability-actions">
            {item.status !== "failed" && <button type="button" className="ghost" onClick={() => void enable()}>{item.status === "active" ? "停用" : "启用"}</button>}
            {item.kind !== "extension" && (removing === item.id
              ? <button type="button" className="danger" onClick={() => { setRemoving(null); void act(call(one(item.id), { method: "DELETE" })); }}>{uploaded ? "确认卸载" : "确认删除"}</button>
              : <button type="button" className="ghost" onClick={() => setRemoving(item.id)}>{uploaded ? "卸载" : "删除"}</button>)}
          </span>
        </div>
        {item.summary && <p>{item.summary}</p>}
        {removing === item.id && item.provides?.includes("pricing") && <p className="error" role="alert">卸载后任务不再估价、不记账，也不受预算上限限制。</p>}
        {item.kind === "interface" && <p className="capability-note">{item.status === "active" && <><a href={`${apiBase}/${encodeURIComponent(item.id)}/`} target="_blank" rel="noreferrer">打开</a> · </>}停用或卸载后这个网页就打不开了；用命令行 <code>fluidform capabilities enable {item.id}</code> 可以再启用。</p>}
        {confirming === item.id && <div className="capability-confirm" role="group" aria-label="确认启用">
          {item.kind === "interface"
            ? <p><b>启用「{item.name}」？</b>它是上传的网页，FluidForm 在 <code>/{item.id}/</code> 提供它。它在你的浏览器里运行，能用 FluidForm 的全部接口（新建和执行任务、改设置）。</p>
            : <p><b>启用「{item.name}」？</b>它是上传的代码，会在沙箱里{item.kind === "automation" || item.kind === "service" ? "一直运行" : "被之后的任务使用"}：</p>}
          {item.kind !== "interface" && <ul>
            <li>能访问：{item.domains.length ? item.domains.join("、") : "不联网"}（只有这些）</li>
            {!!item.secrets.length && <li>会拿到你填的：{item.secrets.join("、")}</li>}
            <li>只能写它自己的数据文件夹，看不到你的主目录和 FluidForm 的数据</li>
            {item.kind === "automation" && <li>别人通过它提的事要你确认才开工；回答的花费只记账，不设上限</li>}
            {!!item.provides?.length && <li>给 FluidForm 提供{named(item.provides)}能力，拿不到你的 API 密钥</li>}
          </ul>}
          {!!lacking.length && <p className="capability-confirm-missing">先在下面填好 {lacking.join("、")}。</p>}
          <span className="capability-actions">
            <button type="button" className="ghost" onClick={() => setConfirming(null)}>取消</button>
            <button type="button" className="primary" disabled={!!lacking.length} onClick={async () => { if (await act(call(one(item.id), sendJson("PATCH", { enabled: true, confirmed: true })))) setConfirming(null); }}>确认启用</button>
          </span>
        </div>}
        <dl>
          {item.usage && <><dt>用法</dt><dd><code>{item.usage}</code></dd></>}
          {!!item.files.length && <><dt>代码</dt><dd>{item.files.map(file => <code key={file} className="capability-file">{file}</code>)}</dd></>}
          {!!item.secrets.length && <><dt>需要</dt><dd>{item.secrets.join("、")}</dd></>}
          {!!item.domains.length && <><dt>访问</dt><dd>{item.domains.join("、")}</dd></>}
          {!!item.provides?.length && <><dt>提供</dt><dd>{named(item.provides)}能力</dd></>}
          {!!item.requires?.length && <><dt>依赖</dt><dd>{named(item.requires)}能力</dd></>}
          {item.source_run_id && <><dt>来自</dt><dd>{source(item.source_run_id)
            ? <button type="button" className="link-button" onClick={() => onOpenRun(item.source_run_id!)}>「{source(item.source_run_id)!.plan.title || source(item.source_run_id)!.plan.summary}」</button>
            : "已删除的任务"}</dd></>}
        </dl>
        {uploaded && state && <PackageControls apiBase={apiBase} item={item} state={state} onChanged={load} act={act} />}
        {item.guide && <details className="capability-guide"><summary>说明书（SKILL.md）</summary><MarkdownView text={item.guide} /></details>}
        {item.kind === "automation" && !uploaded && <p className="capability-note">任务固化的自动化没有入口，不能在后台运行；做成能力包上传后才能运行。</p>}
        {item.status === "failed" && <details className="capability-check"><summary>检查输出</summary><pre>{item.check_output}</pre></details>}
      </li>;
    })}</ul>
  </section>;
}

/** An uploaded package's secrets, and an automation's chat model, state, spending and log. */
function PackageControls({ apiBase, item, state, onChanged, act }: {
  apiBase: string; item: Capability; state: Runtime; onChanged: () => Promise<unknown>; act: (promise: Promise<unknown>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const url = `${apiBase}/api/capabilities/${encodeURIComponent(item.id)}`;
  const running = RUNNING[state.status ?? "off"] ?? RUNNING.off, filled = Object.values(values).some(value => value.trim());
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await act(call(`${url}/secrets`, sendJson("PUT", { values })))) { setValues({}); onChanged(); }
  }
  return <div className="capability-package">
    {(item.kind === "automation" || item.kind === "service") && <div className="capability-run">
      <span className={`dx-chip ${running.tone}`}>{running.tone === "busy" && <i className="pulse" aria-hidden="true" />}{running.label}</span>
      {state.text && <span className="capability-run-text">{state.text}</span>}
      {item.kind === "automation" && <span className="capability-run-counts">今天花了 ${(state.spent_today_usd ?? 0).toFixed(2)} · 已回 {state.handled ?? 0} 条 · {state.conversations ?? 0} 段对话</span>}
    </div>}
    {state.error && <p className="error" role="alert">{state.error}</p>}
    {item.kind === "automation" && <div className="capability-settings">
      <AutomationModel apiBase={apiBase} url={url} name={item.name} modelId={state.model_id} onChanged={onChanged} />
    </div>}
    {!!item.secrets.length && <form className="capability-secrets" onSubmit={save} aria-label={`${item.name}的密钥`}>
      {item.secrets.map(name => <label key={name}>{name}<input type="password" autoComplete="new-password" value={values[name] ?? ""}
        placeholder={state.secrets[name] ? "已保存，要换才填" : "还没填"} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))} /></label>)}
      <div className="capability-secrets-bar">
        <small>存在系统钥匙串里，只交给它自己。</small>
        <button type="submit" className="primary" disabled={!filled}>保存</button>
      </div>
    </form>}
    {!!state.log?.length && <details className="capability-check"><summary>运行日志</summary><pre>{state.log.join("\n")}</pre></details>}
  </div>;
}

/** The same available conversation models as 新建 → 对话, saved for each automation as soon as one is picked. */
function AutomationModel({ apiBase, url, name, modelId, onChanged }: {
  apiBase: string; url: string; name: string; modelId?: string | null; onChanged: () => Promise<unknown>;
}) {
  const [models, setModels] = useState<{ id: string; display_name: string; channel: string }[] | null>(null);
  const [selected, setSelected] = useState(modelId ?? ""), [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [listError, setListError] = useState(""), [error, setError] = useState("");
  useEffect(() => { if (!saving) setSelected(modelId ?? ""); }, [modelId]);
  async function loadModels() {
    setLoading(true); setListError("");
    try { setModels(await call(`${apiBase}/api/chats/models`)); }
    catch (failure) { setListError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadModels(); }, [apiBase]);
  async function choose(next: string) {
    setSelected(next); setSaved(null); setError("");
    if (next === (modelId ?? "")) return;
    setSaving(true);
    try {
      const result = await call<Runtime>(`${url}/model`, sendJson("PUT", { model_id: next || null }));
      setSelected(result.model_id ?? ""); setSaved(result.model_id ?? "");
      await onChanged();
    } catch (failure) {
      setSelected(modelId ?? "");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }
  const label = (id: string) => models?.find(model => model.id === id)?.display_name ?? id;
  return <div className="capability-field capability-model" role="group" aria-label={`${name}的聊天模型`}>
    <label htmlFor={`model-${name}`}>回答用的模型
      {saving ? <span className="capability-field-state" role="status">保存中…</span>
        : saved !== null ? <span className="capability-field-state ok" role="status">已保存：{saved ? label(saved) : "自动选择"}</span>
        : loading ? <span className="capability-field-state" role="status">加载中…</span> : null}</label>
    <select id={`model-${name}`} aria-label={`${name}的聊天模型`} value={selected} disabled={loading || saving}
      onChange={event => void choose(event.target.value)}>
      <option value="">自动选择</option>
      {!!selected && !models?.some(model => model.id === selected) && <option value={selected} disabled>{selected}{models ? "（当前不可用）" : ""}</option>}
      {(models ?? []).map(model => <option key={model.id} value={model.id}>{model.display_name} · {model.channel === "cli" ? "会员 CLI" : "API"}</option>)}
    </select>
    {listError && <p className="error" role="alert">{listError} <button type="button" className="link-button" onClick={() => void loadModels()}>重试</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
    <small>只用来回答问题，下一条起生效；排任务仍自动选。</small>
  </div>;
}

/** On a finished task's result page: what its lead found reusable, to solidify or dismiss. */
export function CapabilityProposals<T>({ apiBase, runId, proposals, onUpdated }: {
  apiBase: string; runId: string; proposals: CapabilityProposal[]; onUpdated: (run: T) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null), [error, setError] = useState("");
  const shown = proposals.map((item, index) => ({ item, index })).filter(({ item }) => item.status !== "dismissed");
  if (!shown.length) return null;
  async function act(index: number, action: "solidify" | "dismiss") {
    setBusy(index); setError("");
    try { onUpdated(await call<T>(`${apiBase}/api/tasks/${encodeURIComponent(runId)}/capabilities/${index}/${action}`, { method: "POST" })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(null); }
  }
  return <section className="capability-proposals" aria-label="可复用的能力">
    <p className="capability-proposals-head"><Icon name="plus" size={14} />这个任务做出了可以复用的能力</p>
    {shown.map(({ item, index }) => <div key={index} className="capability-proposal">
      <div><b>{item.name}</b><span className="capability-kind">{KIND[item.kind] ?? item.kind}</span><p>{item.summary}</p></div>
      {item.status === "solidified"
        ? <span className="capability-status active">已固化，在平台工程师 → 能力里</span>
        : <span className="capability-actions">
          <button type="button" className="ghost" disabled={busy !== null} onClick={() => act(index, "dismiss")}>忽略</button>
          <button type="button" className="primary" disabled={busy !== null} onClick={() => act(index, "solidify")}>{busy === index ? "正在固化…" : "固化"}</button>
        </span>}
    </div>)}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
