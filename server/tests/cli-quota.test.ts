// cli-quota.ts: tests/test_cli_quota.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { tokenCost } from "../src/budget.js";
import * as calls from "../src/calls.js";
import { builtinModels } from "../src/catalog.js";
import * as quota from "../src/cli-quota.js";
import { CodexReader, READERS } from "../src/cli-quota.js";
import { settings } from "../src/config.js";
import { CapabilityScoreSchema, ModelProfileSchema, type ModelProfile } from "../src/models.js";
import { QuotaTracker } from "../src/quota.js";

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000 - 3 * 3600_000);
const RESETS = new Date(NOW.getTime() + 3 * 24 * 3600_000);
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
const saved = { ...settings };
const savedReader = READERS["cli:codex"];
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "quota-")));
  Object.assign(settings, { data_dir: join(home, "data"), lead_root: join(home, "leads"), cli_plans: { "cli:codex": { monthly_usd: 200 } },
    cli_quota_soft_percent: 70, cli_quota_stop_percent: 90 });
  READERS["cli:codex"] = new CodexReader(join(home, "codex"));
  mkdirSync(join(home, "codex", "sessions", "2026", "10", "26"), { recursive: true });
});
afterEach(() => {
  Object.assign(settings, saved);
  READERS["cli:codex"] = savedReader;
});

const iso = (when: Date) => when.toISOString().replace(".000Z", "+00:00");

/** A Codex session file: [minutes after NOW, cumulative input, cached, output, used percent]. */
function session(name: string, cwd: string, events: [number, number, number, number, number][], resets = RESETS): void {
  const lines = [JSON.stringify({ timestamp: iso(NOW), type: "session_meta", payload: { cwd } })];
  for (const [after, input, cached, output, percent] of events) {
    lines.push(JSON.stringify({ timestamp: iso(minutes(after)), type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: { plan_type: "pro", primary: { used_percent: percent, window_minutes: 10080, resets_at: Math.trunc(resets.getTime() / 1000) } } } }));
  }
  writeFileSync(join(home, "codex", "sessions", "2026", "10", "26", name), lines.join("\n") + "\n");
}

const codexModel = (): ModelProfile => builtinModels().find((model) => model.id === "cli:codex")!;
const near = (actual: number, expected: number, rel = 1e-4) => assert.ok(Math.abs(actual - expected) <= rel * Math.abs(expected), `${actual} != ${expected}`);
const two = (value: number) => String(value).padStart(2, "0");
const local = (when: Date) => `${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}:${two(when.getMinutes())}`;

test("the quota comes from the session files, and only the user's own sessions count", async () => {
  session("user.jsonl", join(home, "project"), [[0, 1000, 0, 100, 10.0], [60, 3000, 1000, 300, 12.0]]);
  session("lead.jsonl", join(home, "leads", "task"), [[90, 900_000, 0, 9000, 13.0]]);
  const usage = (await READERS["cli:codex"].read(minutes(30), minutes(120)))!;
  assert.equal(usage.plan, "pro");
  assert.deepEqual(usage.windows.map((w) => [w.used_percent, w.minutes, w.resets_at.getTime()]), [[13.0, 10080, RESETS.getTime()]]);
  // The user's tokens after the 30-minute mark; the lead's session is counted in the ledger instead.
  near(usage.tokens, 1300);
});

test("a CLI is priced by its share of the subscription and charged like an API model", async () => {
  const models = { "cli:codex": codexModel() };
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0]]);
  await quota.apply(models, null, NOW); // the baseline: no price yet
  assert.equal(models["cli:codex"].input_per_million, 0);
  assert.ok(models["cli:codex"].usage_note!.includes("暂未折算"));
  const record = { model_id: "cli:codex", usage_known: true, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } as any;
  calls.current.run([null, record], () => calls.usage(null, 1_000_000, 200_000, 500_000)); // 750,000 weighted tokens
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0], [60, 250_000, 0, 0, 25.0]]);
  await quota.apply(models, null, minutes(60));
  // 1,000,000 weighted tokens for 5% of a week: a week holds 20M; $200 a month is $46.15 a week.
  const model = models["cli:codex"];
  const week = 200 / (52 / 12);
  assert.equal(model.input_per_million, model.output_per_million);
  near(model.input_per_million!, week / 20);
  near(model.cached_input_per_million!, model.input_per_million! * 0.1);
  near(tokenCost(model, 1_000_000, 200_000, 500_000), (week * 750_000) / 20_000_000, 1e-3);
  assert.ok(model.usage_note!.includes("周额度已用 25%") && model.usage_note!.includes("按月费 $200 折算"));
  // The calibration is kept: after the window resets, the CLI keeps its price.
  session("next.jsonl", join(home, "project"), [[120, 0, 0, 0, 0.5]], new Date(RESETS.getTime() + 7 * 24 * 3600_000));
  await quota.apply(models, null, minutes(120));
  near(models["cli:codex"].input_per_million!, week / 20);
});

test("quota used where its tokens cannot be seen never prices a CLI above its provider's API", async () => {
  const offered = { context_window: 200_000, scores: codexModel().scores ?? CapabilityScoreSchema.parse({}) };
  const make = (fields: Record<string, unknown>) => ModelProfileSchema.parse({ channel: "api", ...offered, ...fields });
  const priciest = make({ id: "openai:big", provider: "openai", display_name: "Big", input_per_million: 10, output_per_million: 50, cached_input_per_million: 1 });
  const cheap = make({ id: "openai:small", provider: "openai", display_name: "Small", input_per_million: 0.1, output_per_million: 0.5 });
  const other = make({ id: "x:huge", provider: "x", display_name: "Huge", input_per_million: 100, output_per_million: 500 });
  const retired = make({ id: "openai:old-pro", provider: "openai", display_name: "Old Pro", input_per_million: 150, output_per_million: 600, catalog_status: "retired" });
  const models: Record<string, ModelProfile> = { "cli:codex": codexModel(), [priciest.id]: priciest, [cheap.id]: cheap, [other.id]: other, [retired.id]: retired };
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0]]);
  await quota.apply(models, null, NOW);
  // 30% of the week went on another machine or the web; here only 10,000 tokens were seen.
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0], [60, 10_000, 0, 0, 50.0]]);
  await quota.apply(models, null, minutes(60));
  const model = models["cli:codex"];
  assert.deepEqual([model.input_per_million, model.output_per_million, model.cached_input_per_million], [10, 50, 1]);
  assert.ok(tokenCost(model, 29_478, 412, 11_904) < 0.25);
  assert.ok(model.usage_note!.includes("看不到的用量"));
});

test("a tight quota loses first place, and a full one takes no new work until it resets", async () => {
  const models = { "cli:codex": codexModel() };
  const tracker = new QuotaTracker();
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 75.0]]);
  await quota.apply(models, tracker, NOW);
  assert.equal(models["cli:codex"].execution_priority, 100);
  assert.ok(models["cli:codex"].usage_note!.includes("额度紧张") && !tracker.exhausted("cli:codex"));
  session("later.jsonl", join(home, "project"), [[10, 0, 0, 0, 92.0]]);
  await quota.apply(models, tracker, NOW);
  assert.ok(tracker.exhausted("cli:codex"));
  const [mark] = tracker.public();
  assert.equal(mark.until, iso(RESETS));
  assert.ok(mark.reason.includes("停用线 90%"));
  session("next.jsonl", join(home, "project"), [[20, 0, 0, 0, 10.0]], new Date(RESETS.getTime() + 7 * 24 * 3600_000));
  await quota.apply(models, tracker, NOW); // a new window
  assert.ok(!tracker.exhausted("cli:codex"));
  assert.equal(models["cli:codex"].execution_priority, 0);
});

test("without a plan a CLI costs nothing and goes first as before", async () => {
  settings.cli_plans = {};
  const models = { "cli:codex": codexModel() };
  const tracker = new QuotaTracker();
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 95.0]]);
  await quota.apply(models, tracker, NOW);
  const model = models["cli:codex"];
  assert.deepEqual([model.input_per_million, model.execution_priority, model.usage_note], [0, 0, null]);
  assert.ok(!tracker.exhausted("cli:codex"));
});

test("a starting price is charged until the quota calibrates one", async () => {
  settings.cli_plans = { "cli:codex": { monthly_usd: 200, input_per_million: 0.6, output_per_million: 2.4 } };
  let models = { "cli:codex": codexModel() };
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0]]);
  await quota.apply(models, null, NOW);
  const model = models["cli:codex"];
  assert.deepEqual([model.input_per_million, model.output_per_million], [0.6, 2.4]);
  near(model.cached_input_per_million!, 0.06);
  assert.ok(model.usage_note!.includes("先按设定价"));
  // Usage that cannot be read still charges the set price, not nothing.
  READERS["cli:codex"] = new CodexReader(join(home, "missing"));
  models = { "cli:codex": codexModel() };
  await quota.apply(models, null, NOW);
  assert.deepEqual([models["cli:codex"].input_per_million, models["cli:codex"].output_per_million], [0.6, 2.4]);
});

test("a stale full reading is checked with Codex, and a window reset early lets it work again", async () => {
  const asked: (string | null)[] = [];
  READERS["cli:codex"] = new CodexReader(join(home, "codex"), async (where) => {
    asked.push(where);
    return { plan_type: "pro", primary: { used_percent: 14, window_minutes: 10080, resets_at: Math.trunc(RESETS.getTime() / 1000) + 2 * 86400 } };
  });
  const models = { "cli:codex": codexModel() };
  const tracker = new QuotaTracker();
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 92.0]]);
  await quota.apply(models, tracker, NOW);
  assert.ok(tracker.exhausted("cli:codex") && asked.length === 0); // a fresh reading needs no question
  // Stopped, Codex writes nothing new; its window reset before the time it gave.
  await quota.apply(models, tracker, minutes(quota.STALE_MINUTES + 1));
  assert.ok(!tracker.exhausted("cli:codex") && asked.length === 1);
  assert.ok(models["cli:codex"].usage_note!.includes("14%"));
  await quota.apply(models, tracker, minutes(quota.STALE_MINUTES + 2));
  assert.equal(asked.length, 1);
});

test("when Codex cannot say, the last reading stands", async () => {
  READERS["cli:codex"] = new CodexReader(join(home, "codex"), async () => null);
  const models = { "cli:codex": codexModel() };
  const tracker = new QuotaTracker();
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 92.0]]);
  await quota.apply(models, tracker, minutes(60));
  assert.ok(tracker.exhausted("cli:codex"));
});

test("a free CLI keeps its quota guard but costs nothing", async () => {
  Object.assign(settings, { cli_free: true, cli_plans: { "cli:codex": { monthly_usd: 200, input_per_million: 0.6, output_per_million: 2.4 } } });
  const models = { "cli:codex": codexModel() };
  const tracker = new QuotaTracker();
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0]]);
  await quota.apply(models, tracker, NOW); // before calibration: no starting price either
  const model = models["cli:codex"];
  assert.deepEqual([model.input_per_million, model.output_per_million, model.cached_input_per_million], [0, 0, 0]);
  session("user.jsonl", join(home, "project"), [[0, 0, 0, 0, 20.0], [60, 250_000, 0, 0, 92.0]]);
  await quota.apply(models, tracker, minutes(60));
  assert.equal(tokenCost(model, 1_000_000, 200_000, 500_000), 0);
  assert.equal(model.usage_note, `周额度已用 92%，${local(RESETS)} 重置；额度紧张，优先给其他模型`);
  assert.ok(model.execution_priority === 100 && tracker.exhausted("cli:codex"));
  // Unreadable usage: still free, not the plan's starting price.
  READERS["cli:codex"] = new CodexReader(join(home, "nowhere"));
  await quota.apply(models, null, minutes(120));
  assert.deepEqual([model.input_per_million, model.output_per_million], [0, 0]);
});
