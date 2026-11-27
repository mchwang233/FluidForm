import React, { useEffect, useId, useRef, useState } from "react";
import { CatalogStatus, dateLabel } from "./catalog-status";
import { BenchmarkComparison, PublicBenchmarks, type BenchmarkResult } from "./public-benchmarks";
import "./model-profiles.css";

export const CAPABILITIES = [
  { key: "coding", label: "代码", description: "代码理解、实现功能与排查问题" },
  { key: "planning", label: "规划", description: "拆分目标、安排步骤与依赖" },
  { key: "research", label: "调研", description: "整理资料、比较方案与归纳结论" },
  { key: "chinese", label: "中文", description: "中文理解与表达" },
  { key: "tool_use", label: "工具使用", description: "选择工具与组织工具调用" },
  { key: "structured_output", label: "结构化输出", description: "按指定格式生成可处理的结果" },
  { key: "reliability", label: "可靠性", description: "由 AA 非幻觉率换算，不是实测成功率" },
] as const;

export type CapabilityKey = typeof CAPABILITIES[number]["key"];
type ChannelFilter = "all" | "cli" | "api";

export type Model = {
  id: string;
  display_name: string;
  provider: string;
  /** The provider's name, from its model package. */
  provider_name?: string | null;
  channel: string;
  auth_type?: string;
  usage_note?: string | null;
  configured: boolean;
  enabled: boolean;
  input_per_million: number | null;
  output_per_million: number | null;
  context_window: number | null;
  pricing_verified: boolean;
  scores: Record<CapabilityKey, number> | null;
  routing_ready: boolean;
  scores_source?: string;
  scores_basis?: string | null;
  catalog_source: string;
  catalog_status: string;
  catalog_checked_at?: string | null;
  discovered_at?: string;
  release_date?: string | null;
  pricing_source: string;
  available_via_api?: boolean | null;
  api_checked_at?: string | null;
  source_url?: string | null;
  description?: string | null;
  supports_tools?: boolean | null;
  supports_vision?: boolean | null;
  supports_reasoning?: boolean | null;
  supports_structured_output?: boolean | null;
  benchmarks?: BenchmarkResult[];
};

type Props = {
  models: Model[];
  selectedId: string;
  onSelect: (id: string) => void;
  onToggle: (model: Model) => Promise<void>;
  onConfigure: (model: Model) => void;
  apiBase: string;
};

export function score(model: Model, key: CapabilityKey): number | null {
  const value = model.scores?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value))) : null;
}

export function Radar({ model }: { model: Model }) {
  const titleId = useId();
  const descriptionId = useId();
  const point = (index: number, radius: number) => {
    const angle = index * Math.PI * 2 / CAPABILITIES.length - Math.PI / 2;
    return [200 + Math.cos(angle) * radius, 175 + Math.sin(angle) * radius];
  };
  const ring = (radius: number) => CAPABILITIES.map((_, index) => point(index, radius).join(",")).join(" ");
  const complete = CAPABILITIES.every(({ key }) => score(model, key) !== null);
  return <figure className="profile-radar">
    <svg viewBox="0 0 400 350" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>{`${model.display_name} 的能力雷达图`}</title>
      <desc id={descriptionId}>各轴均为 0–100 分的调度评分。{CAPABILITIES.map(({ key, label }) => `${label} ${score(model, key) ?? "暂无"}`).join("，")}</desc>
      {[25, 50, 75, 100].map(level => <polygon key={level} points={ring(level)} className="radar-ring" />)}
      {CAPABILITIES.map(({ key }, index) => {
        const [x, y] = point(index, 100);
        return <line key={key} x1="200" y1="175" x2={x} y2={y} className="radar-axis" />;
      })}
      {complete && <polygon points={CAPABILITIES.map(({ key }, index) => point(index, score(model, key)!).join(",")).join(" ")} className="radar-area" />}
      {!complete && <text x="200" y="205" textAnchor="middle" className="radar-label">待评估</text>}
      {[25, 50, 75, 100].map(level => <text key={level} x="205" y={175 - level - 4} className="radar-scale">{level}</text>)}
      {CAPABILITIES.map(({ key, label }, index) => {
        const value = score(model, key);
        const [x, y] = point(index, 130);
        const [dotX, dotY] = point(index, value ?? 0);
        return <g key={key}>
          {value !== null && <circle cx={dotX} cy={dotY} r="3.5" className="radar-point" />}
          <text x={x} y={y} textAnchor={x > 210 ? "start" : x < 190 ? "end" : "middle"} dominantBaseline="middle" className="radar-label">{label}</text>
        </g>;
      })}
    </svg>
    <figcaption>统一 0–100 刻度 · {!model.scores ? "尚无能力评分" : model.provider === "mock" ? "模拟画像" : "调度画像"}</figcaption>
  </figure>;
}

/** Calls and spend per model over the last days (GET /api/models/usage). */
type Usage = { calls: number; cost_usd: number; run_count: number; runs: { id: string; title: string; kind: string; calls: number }[] };

function shortName(model: Model) { return model.display_name.replace(/\s*\(membership\)\s*$/i, ""); }
const providerName = (model: Model) => model.provider_name ?? model.provider;
/** Two letters for the avatar: a CLI's own name, else its provider's. */
function monogram(model: Model) {
  return model.provider === "mock" ? "DM" : (model.channel === "cli" ? shortName(model) : providerName(model)).slice(0, 2);
}
function tokens(count: number | null) {
  if (!count) return "—";
  return count >= 1_000_000 ? `${+(count / 1_000_000).toFixed(1)}M` : `${Math.round(count / 1000)}K`;
}
function price(value: number | null) { return value === null ? "—" : `$${value < 1 ? value.toFixed(2) : +value.toFixed(2)}`; }
function money(value: number) { return value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : value > 0 ? `$${value.toFixed(3)}` : "$0"; }
/** What a row says about a model under its name. */
function facts(model: Model) {
  const parts = model.channel === "cli" ? ["会员额度"] : model.provider === "mock" ? ["演示"] : [`${price(model.input_per_million)} / ${price(model.output_per_million)} 每百万`];
  parts.push(`${tokens(model.context_window)} 上下文`);
  if (model.supports_vision) parts.push("看图");
  return parts.join(" · ");
}
function strengths(model: Model) {
  return CAPABILITIES.filter(({ key }) => key !== "reliability" && score(model, key) !== null)
    .sort((a, b) => score(model, b.key)! - score(model, a.key)!).slice(0, 3).map(item => item.label);
}

function Switch({ model, onToggle }: { model: Model; onToggle: (model: Model) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const blocked = !model.enabled && (!model.routing_ready || !model.configured);
  return <button type="button" role="switch" aria-checked={model.enabled} className={`models-switch${model.enabled ? " on" : ""}`}
    disabled={pending || blocked} aria-label={`${model.enabled ? "停用" : "启用"} ${shortName(model)}`}
    title={blocked ? (!model.configured ? (model.channel === "cli" ? "本机没有找到这个 CLI" : "先配置密钥") : "暂无评测成绩，暂不参与调度") : undefined}
    onClick={async event => { event.stopPropagation(); setPending(true); try { await onToggle(model); } finally { setPending(false); } }}><span /></button>;
}

function Row({ model, usage, selected, onSelect, onToggle }: { model: Model; usage?: Usage; selected: boolean; onSelect: () => void; onToggle: (model: Model) => Promise<void> }) {
  const used = usage?.calls ? `${usage.calls} 次${model.channel === "cli" ? "" : ` · ${money(usage.cost_usd)}`}` : "没用过";
  return <div className={`models-row${selected ? " selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected} onClick={onSelect}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
    <span className="models-avatar" aria-hidden="true">{monogram(model)}</span>
    <span className="models-row-main"><span className="models-row-name"><b>{shortName(model)}</b><span className="models-chip">{model.channel === "cli" ? "会员 CLI" : model.provider === "mock" ? "演示" : "API"}</span></span><small>{facts(model)}</small></span>
    <span className="models-row-used">{used}</span>
    <Switch model={model} onToggle={onToggle} />
  </div>;
}

/** One provider whose models wait for a key, or a CLI not found on this machine. */
function MissingRow({ name, models, cli, selected, onSelect, onConfigure }: { name: string; models: Model[]; cli: boolean; selected: boolean; onSelect: () => void; onConfigure: () => void }) {
  return <div className={`models-row missing${selected ? " selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected} onClick={onSelect}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
    <span className="models-avatar" aria-hidden="true">{cli ? monogram(models[0]) : name.slice(0, 2)}</span>
    <span className="models-row-main"><span className="models-row-name"><b>{name}</b></span><small>{cli ? "会员 CLI · 本机没有找到" : models.map(shortName).join("、")}</small></span>
    {cli ? <span className="models-row-used">安装并登录后自动出现</span>
      : <button type="button" className="models-pill" onClick={event => { event.stopPropagation(); onConfigure(); }}>配置密钥</button>}
  </div>;
}

function Detail({ model, usage, onToggle, onConfigure }: { model: Model; usage?: Usage; onToggle: (model: Model) => Promise<void>; onConfigure: (model: Model) => void }) {
  const cli = model.channel === "cli", best = strengths(model);
  const state = !model.configured ? (cli ? "本机没有找到" : "缺密钥") : model.enabled ? "已启用" : "没启用";
  const scored = CAPABILITIES.filter(({ key }) => score(model, key) !== null);
  const features = ([["supports_tools", "工具调用"], ["supports_vision", "看图"], ["supports_reasoning", "推理"], ["supports_structured_output", "结构化输出"]] as const).filter(([key]) => model[key]);
  return <aside className="models-detail" aria-label={`${shortName(model)} 的详情`}>
    <div className="models-detail-head">
      <span className="models-avatar big" aria-hidden="true">{monogram(model)}</span>
      <div><h3>{shortName(model)}</h3><small>{cli ? "会员 CLI" : "API"} · {providerName(model)} · {state}</small></div>
      <Switch model={model} onToggle={onToggle} />
    </div>
    <p className="models-detail-lead">{!model.scores ? "暂无评测成绩，暂不参与调度。" : best.length ? `调度时更常把${best.join("、")}的活交给它。` : ""}
      {cli && model.usage_note ? ` 会员用量：${model.usage_note}。` : ""}</p>
    {!model.configured && !cli && <button type="button" className="models-pill wide" onClick={() => onConfigure(model)}>配置 {providerName(model)} 的密钥</button>}
    <div className="models-stats">
      <div><span>输入</span><b>{cli ? "会员" : price(model.input_per_million)}</b><small>{cli ? "按会员额度" : "每百万 token"}</small></div>
      <div><span>输出</span><b>{cli ? "会员" : price(model.output_per_million)}</b><small>{cli ? "不另计费" : "每百万 token"}</small></div>
      <div><span>上下文</span><b>{tokens(model.context_window)}</b><small>token</small></div>
      <div><span>近 30 天</span><b>{cli ? `${usage?.calls ?? 0} 次` : money(usage?.cost_usd ?? 0)}</b><small>{cli ? `${usage?.run_count ?? 0} 个任务或对话` : `${usage?.calls ?? 0} 次调用`}</small></div>
    </div>
    {scored.length > 0 && <><h4>调度时怎么看它</h4>
      <div className="models-bars">{scored.map(({ key, label, description }) => <div key={key} title={description}><span>{label}</span>
        <span className="models-bar" role="meter" aria-label={`${label}调度评分`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score(model, key)!}><i style={{ width: `${score(model, key)}%` }} /></span><b>{score(model, key)}</b></div>)}</div></>}
    {features.length > 0 && <div className="models-features">{features.map(([key, label]) => <span className="models-chip" key={key}>{label}</span>)}</div>}
    {!!usage?.runs.length && <><h4>最近用在</h4><ul className="models-used-in">{usage.runs.map(run => <li key={run.id}><span>{run.title}</span><small>{run.kind === "chat" ? "对话" : "任务"} · {run.calls} 次</small></li>)}
      {usage.run_count > usage.runs.length && <li className="muted">还有 {usage.run_count - usage.runs.length} 个</li>}</ul></>}
    <details className="models-fold"><summary>Artificial Analysis 成绩</summary>
      {model.scores_basis && <p className="muted">{model.scores_basis}</p>}
      <PublicBenchmarks results={model.benchmarks ?? []} /></details>
    <details className="models-fold"><summary>目录来源与核对时间</summary>
      {model.description && <p className="muted">{model.description}</p>}
      <dl className="models-facts">
        <div><dt>型号</dt><dd><code>{model.id}</code></dd></div>
        <div><dt>发布日期</dt><dd>{model.release_date ?? "来源未提供"}</dd></div>
        <div><dt>目录来源</dt><dd>{model.catalog_source === "models.dev" ? "Models.dev 社区目录" : model.catalog_source === "official" ? "官方模型接口" : "项目内置"}{model.source_url?.startsWith("https://") && <> · <a href={model.source_url} target="_blank" rel="noreferrer">查看 ↗</a></>}</dd></div>
        <div><dt>价格依据</dt><dd>{cli ? "取决于 CLI 账户" : model.pricing_verified ? "目录标记为已核验" : model.pricing_source === "models.dev" ? "Models.dev 参考起步价" : "预设价格，待核验"}</dd></div>
        <div><dt>目录检查</dt><dd>{dateLabel(model.catalog_checked_at)}</dd></div>
        <div><dt>官方接口</dt><dd>{model.available_via_api === true ? "上次核对时可见" : model.available_via_api === false ? "上次核对时未列出" : "尚未核对"}</dd></div>
      </dl>
      {model.configured && !cli && model.provider !== "mock" && <button type="button" className="link-button" onClick={() => onConfigure(model)}>更换密钥</button>}
    </details>
  </aside>;
}

/** 模型: who works for you and what it cost, who is ready but off, and who waits for a key; a
 * model's details beside the list, its scores and catalog facts folded. */
export function ModelProfiles({ models, selectedId, onSelect, onToggle, onConfigure, apiBase }: Props) {
  const [query, setQuery] = useState(""), [channel, setChannel] = useState<ChannelFilter>("all");
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  useEffect(() => {
    let live = true;
    fetch(`${apiBase}/api/models/usage`).then(response => response.ok ? response.json() : null)
      .then(body => { if (live && body?.models) setUsage(body.models); }).catch(() => {});
    return () => { live = false; };
  }, [apiBase]);
  const search = query.trim().toLowerCase();
  const shown = models.filter(model => model.catalog_status !== "retired"
    && (channel === "all" || model.channel === channel)
    && `${model.display_name} ${model.id} ${providerName(model)}`.toLowerCase().includes(search));
  const busiest = (a: Model, b: Model) => (usage[b.id]?.calls ?? 0) - (usage[a.id]?.calls ?? 0) || a.display_name.localeCompare(b.display_name);
  const inUse = shown.filter(model => model.configured && model.enabled).sort(busiest);
  const ready = shown.filter(model => model.configured && !model.enabled).sort(busiest);
  const missing = shown.filter(model => !model.configured);
  const waiting = new Map<string, Model[]>();
  for (const model of missing) {
    const key = model.channel === "cli" ? model.id : model.provider;
    waiting.set(key, [...(waiting.get(key) ?? []), model]);
  }
  const all = [...inUse, ...ready, ...missing];
  const selected = all.find(model => model.id === selectedId) ?? all[0];
  const detail = useRef<HTMLDivElement>(null);
  // On a narrow screen the details are under the list: picking a model brings them into view.
  const pick = (id: string) => { onSelect(id); if (window.innerWidth <= 1000) setTimeout(() => detail.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }), 0); };
  return <section className="models-page" aria-labelledby="models-title">
    <div className="models-main">
      <div className="models-head">
        <div><h2 id="models-title">模型</h2><p>谁在帮你干活、花了多少，还能再接上谁。</p></div>
        <details className="models-sources"><summary>目录与评分来源</summary><CatalogStatus apiBase={apiBase} /></details>
      </div>
      <div className="models-toolbar">
        <label className="models-search"><span className="sr-only">搜索模型</span><input type="search" placeholder="搜索模型或服务商" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="models-filter" role="group" aria-label="按接入方式筛选">{([["all", "全部"], ["cli", "会员 CLI"], ["api", "API"]] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={channel === value} onClick={() => setChannel(value)}>{label}</button>)}</div>
      </div>
      {!models.length ? <p className="models-empty">正在读取模型…</p> : !all.length ? <p className="models-empty">没有匹配的模型。</p> : <>
        {inUse.length > 0 && <section className="models-group" aria-label="在用"><h3>在用 · {inUse.length}<small>次数和花费是近 30 天</small></h3>
          {inUse.map(model => <Row key={model.id} model={model} usage={usage[model.id]} selected={selected?.id === model.id} onSelect={() => pick(model.id)} onToggle={onToggle} />)}</section>}
        {ready.length > 0 && <section className="models-group" aria-label="已配好，没启用"><h3>已配好，没启用 · {ready.length}</h3>
          {ready.map(model => <Row key={model.id} model={model} usage={usage[model.id]} selected={selected?.id === model.id} onSelect={() => pick(model.id)} onToggle={onToggle} />)}</section>}
        {waiting.size > 0 && <section className="models-group" aria-label="缺密钥"><h3>缺密钥或没安装 · {missing.length} 个模型</h3>
          {[...waiting.entries()].map(([key, group]) => <MissingRow key={key} name={group[0].channel === "cli" ? shortName(group[0]) : providerName(group[0])}
            models={group} cli={group[0].channel === "cli"} selected={group.some(model => model.id === selected?.id)}
            onSelect={() => pick(group[0].id)} onConfigure={() => onConfigure(group[0])} />)}</section>}
        <details className="models-fold models-compare"><summary>所有模型的评测对比</summary>
          <BenchmarkComparison models={shown} onSelect={id => { onSelect(id); window.scrollTo({ top: 0 }); }} /></details>
      </>}
    </div>
    {selected && <div ref={detail} className="models-detail-wrap"><Detail key={selected.id} model={selected} usage={usage[selected.id]} onToggle={onToggle} onConfigure={onConfigure} /></div>}
  </section>;
}
