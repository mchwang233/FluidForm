// The records FluidForm keeps: their schemas (first generated from the Python models; edited here since).
import { z } from "zod";
import { lax, model, newId, nowIso } from "./lax.js";

export const RunStatus = z.enum(["draft", "awaiting_confirmation", "queued", "running", "paused", "succeeded", "failed", "cancelled", "incomplete"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const NodeStatus = z.enum(["pending", "running", "succeeded", "failed", "blocked", "cancelled", "unable"]);
export type NodeStatus = z.infer<typeof NodeStatus>;
export const RiskLevel = z.enum(["safe", "review", "restricted"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const CapabilityScoreFields = {
  coding: lax.number().default(() => (50)),
  planning: lax.number().default(() => (50)),
  research: lax.number().default(() => (50)),
  chinese: lax.number().default(() => (50)),
  tool_use: lax.number().default(() => (50)),
  structured_output: lax.number().default(() => (50)),
  reliability: lax.number().default(() => (50)),
};
export const CapabilityScoreSchema = model("CapabilityScore", CapabilityScoreFields);
export type CapabilityScore = z.output<typeof CapabilityScoreSchema>;

export const ModelProfileFields = {
  id: z.string(),
  provider: z.string(),
  display_name: z.string(),
  enabled: lax.bool().default(() => (true)),
  context_window: lax.int(z.number().int().gt(0)).nullable().default(() => (null)),
  max_output_tokens: lax.int(z.number().int().gt(0)).nullable().default(() => (null)),
  input_per_million: lax.number(z.number().min(0)).nullable().default(() => (null)),
  output_per_million: lax.number(z.number().min(0)).nullable().default(() => (null)),
  cached_input_per_million: lax.number().nullable().default(() => (null)),
  supports_tools: lax.bool().nullable().default(() => (null)),
  supports_vision: lax.bool().nullable().default(() => (null)),
  supports_reasoning: lax.bool().nullable().default(() => (null)),
  supports_structured_output: lax.bool().nullable().default(() => (null)),
  scores: CapabilityScoreSchema.nullable().default(() => (null)),
  scores_source: z.string().default(() => ("none" as const)),
  scores_basis: z.string().nullable().default(() => (null)),
  source_url: z.string().nullable().default(() => (null)),
  effective_at: lax.datetime().default(nowIso),
  pricing_verified: lax.bool().default(() => (false)),
  channel: z.string().default(() => ("api" as const)),
  execution_priority: lax.int().default(() => (100)),
  usage_note: z.string().nullable().default(() => (null)),
  description: z.string().nullable().default(() => (null)),
  release_date: lax.date().nullable().default(() => (null)),
  catalog_source: z.string().default(() => ("builtin" as const)),
  catalog_status: z.string().default(() => ("listed" as const)),
  catalog_checked_at: lax.datetime().nullable().default(() => (null)),
  discovered_at: lax.datetime().default(nowIso),
  pricing_source: z.string().default(() => ("builtin" as const)),
  available_via_api: lax.bool().nullable().default(() => (null)),
  api_checked_at: lax.datetime().nullable().default(() => (null)),
};
export const ModelProfileSchema = model("ModelProfile", ModelProfileFields);
export type ModelProfile = z.output<typeof ModelProfileSchema>;

export const ToolCallFields = {
  turn: lax.int(),
  tool: z.string(),
  detail: z.string().default(() => ("" as const)),
  ok: lax.bool().nullable().default(() => (null)),
  id: z.string().nullable().default(() => (null)),
  exit_code: lax.int().nullable().default(() => (null)),
  running: lax.bool().default(() => (false)),
  status: z.enum(["succeeded", "failed", "running", "incomplete", "unknown"]).default(() => ("unknown" as const)),
  diagnostic: z.string().nullable().default(() => (null)),
  output: z.string().default(() => ("" as const)),
  output_size: lax.int().nullable().default(() => (null)),
};
export const ToolCallSchema = model("ToolCall", ToolCallFields);
export type ToolCall = z.output<typeof ToolCallSchema>;

export const NodeAttemptFields = {
  duration_seconds: lax.number().nullable().default(() => (null)),
  result: z.string().nullable().default(() => (null)),
  result_source: z.string().nullable().default(() => (null)),
  interrupted: lax.bool().default(() => (false)),
  model_id: z.string().nullable().default(() => (null)),
  outcome: z.string(),
  reason: z.string().nullable().default(() => (null)),
  reviewer_model_id: z.string().nullable().default(() => (null)),
  cost_usd: lax.number().default(() => (0.0)),
  turns: lax.int().default(() => (0)),
  turn_limit: lax.bool().default(() => (false)),
  tool_calls: z.array(ToolCallSchema).default(() => []),
  trace: z.string().nullable().default(() => (null)),
  finished_at: lax.datetime().default(nowIso),
};
export const NodeAttemptSchema = model("NodeAttempt", NodeAttemptFields);
export type NodeAttempt = z.output<typeof NodeAttemptSchema>;

export const NodeInputFields = {
  node_id: z.string(),
  form: z.string(),
  changed_files: lax.int().default(() => (0)),
};
export const NodeInputSchema = model("NodeInput", NodeInputFields);
export type NodeInput = z.output<typeof NodeInputSchema>;

export const ArtifactFields = {
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]).default(() => ("file" as const)),
};
export const ArtifactSchema = model("Artifact", ArtifactFields);
export type Artifact = z.output<typeof ArtifactSchema>;

export const ArtifactInputFields = {
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]).default(() => ("file" as const)),
  source: z.enum(["external", "dependency"]),
};
export const ArtifactInputSchema = model("ArtifactInput", ArtifactInputFields);
export type ArtifactInput = z.output<typeof ArtifactInputSchema>;

export const ArtifactContractFields = {
  stage: z.enum(["coverage_vdb", "urg_report", "delivery_audit"]).nullable().default(() => (null)),
  inputs: z.array(ArtifactInputSchema),
  outputs: z.array(ArtifactSchema).min(1),
  acceptance_commands: z.array(z.string()).min(1),
  blocked_when: z.array(z.string()).min(1),
  max_turns: z.number().int().gt(0),
  max_cost_usd: lax.number(z.number().gt(0)),
};
export const ArtifactContractSchema = model("ArtifactContract", ArtifactContractFields);
export type ArtifactContract = z.output<typeof ArtifactContractSchema>;

export const ArtifactEvidenceFields = {
  generation: lax.int(),
  inputs: z.record(z.string(), z.string()).default(() => ({})),
  outputs: z.record(z.string(), z.string()).default(() => ({})),
  checks: z.array(z.record(z.string(), z.any())).default(() => []),
  accepted: lax.bool().default(() => (false)),
};
export const ArtifactEvidenceSchema = model("ArtifactEvidence", ArtifactEvidenceFields);
export type ArtifactEvidence = z.output<typeof ArtifactEvidenceSchema>;

export const TaskNodeFields = {
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  capability: z.string(),
  dependencies: z.array(z.string()).default(() => []),
  estimated_input_tokens: lax.int().default(() => (1500)),
  estimated_output_tokens: lax.int().default(() => (800)),
  quality_threshold: lax.number().default(() => (65)),
  difficulty: z.string().default(() => ("normal" as const)),
  needs_workspace: lax.bool().default(() => (false)),
  needs_images: lax.bool().default(() => (false)),
  files: z.array(z.string()).default(() => []),
  reads: z.array(z.string()).default(() => []),
  folders: z.array(z.string()).default(() => []),
  provides: z.string().default(() => ("" as const)),
  check: z.string().default(() => ("" as const)),
  artifact_contract: ArtifactContractSchema.nullable().default(() => (null)),
  artifact_evidence: ArtifactEvidenceSchema.nullable().default(() => (null)),
  contract_turns: lax.int().default(() => (0)),
  contract_tool_calls: lax.int().default(() => (0)),
  contract_cost_usd: lax.number().default(() => (0.0)),
  contract_generation: lax.int().nullable().default(() => (null)),
  artifact_baseline: z.record(z.string(), z.string()).default(() => ({})),
  artifact_inputs: z.record(z.string(), z.string()).default(() => ({})),
  part_id: z.string().nullable().default(() => (null)),
  employee_id: z.string().nullable().default(() => (null)),
  delegation_parent_id: z.string().nullable().default(() => (null)),
  delegation_request_id: z.string().nullable().default(() => (null)),
  delegation_payload_hash: z.string().default(() => ("" as const)),
  after_parts: z.array(z.string()).default(() => []),
  model_id: z.string().nullable().default(() => (null)),
  routing_note: z.string().nullable().default(() => (null)),
  started_at: lax.datetime().nullable().default(() => (null)),
  waiting_for_folder: lax.bool().default(() => (false)),
  preparing: lax.bool().default(() => (false)),
  head_start: z.string().default(() => ("" as const)),
  head_start_generation: lax.int().nullable().default(() => (null)),
  estimated_cost_usd: lax.number().default(() => (0.0)),
  status: NodeStatus.default(() => ("pending" as const)),
  result: z.string().nullable().default(() => (null)),
  acceptance_criteria: z.string().default(() => ("" as const)),
  verifies: z.array(z.string()).default(() => []),
  attempts: z.array(NodeAttemptSchema).default(() => []),
  failed_attempts: lax.int().default(() => (0)),
  environment_fixes: lax.int().default(() => (0)),
  feedback: z.string().nullable().default(() => (null)),
  review_passed: lax.bool().nullable().default(() => (null)),
  /** Done because its lead accepted it after an attempt that did not pass (leading.ts accept), not by passing. */
  accepted_by_lead: lax.bool().default(() => (false)),
  review: z.string().nullable().default(() => (null)),
  unable_reason: z.string().nullable().default(() => (null)),
  summary: z.string().nullable().default(() => (null)),
  changed_files: z.array(z.string()).default(() => []),
  changed_files_total: lax.int().nullable().default(() => (null)),
  inputs: z.array(NodeInputSchema).default(() => []),
  generation: lax.int().default(() => (0)),
};
export const TaskNodeSchema = model("TaskNode", TaskNodeFields);
export type TaskNode = z.output<typeof TaskNodeSchema>;

export const CostEstimateFields = {
  base_usd: lax.number(),
  retry_reserve_usd: lax.number(),
  tool_reserve_usd: lax.number(),
  low_usd: lax.number(),
  high_usd: lax.number(),
  hard_limit_usd: lax.number(),
  calibrated_usd: lax.number().nullable().default(() => (null)),
};
export const CostEstimateSchema = model("CostEstimate", CostEstimateFields);
export type CostEstimate = z.output<typeof CostEstimateSchema>;

export const PlanPartFields = {
  id: z.string(),
  title: z.string(),
  goal: z.string().default(() => ("" as const)),
  acceptance: z.string().default(() => ("" as const)),
  parent_id: z.string().nullable().default(() => (null)),
  employee_id: z.string().nullable().default(() => (null)),
  dependencies: z.array(z.string()).default(() => []),
  provides: z.string().default(() => ("" as const)),
  size: lax.int().default(() => (0)),
  capability: z.string().default(() => ("coding" as const)),
  difficulty: z.enum(["easy", "normal", "hard"]).default(() => ("normal" as const)),
  refinement_effort: z.enum(["", "low", "medium", "high", "max"]).default(() => ("" as const)),
  refinement_reason: z.string().default(() => ("" as const)),
  estimated_cost_usd: lax.number().default(() => (0.0)),
  status: z.string().default(() => ("ready" as const)),
  error: z.string().nullable().default(() => (null)),
};
export const PlanPartSchema = model("PlanPart", PlanPartFields);
export type PlanPart = z.output<typeof PlanPartSchema>;

export const PreflightCheckFields = {
  name: z.string(),
  command: z.string().default(() => ("" as const)),
  ok: lax.bool().default(() => (true)),
  blocking: lax.bool().default(() => (true)),
  output: z.string().default(() => ("" as const)),
};
export const PreflightCheckSchema = model("PreflightCheck", PreflightCheckFields);
export type PreflightCheck = z.output<typeof PreflightCheckSchema>;

export const PreflightFields = {
  checked_at: lax.datetime().default(nowIso),
  passed: lax.bool().default(() => (true)),
  checks: z.array(PreflightCheckSchema).default(() => []),
  repaired: lax.bool().default(() => (false)),
  paused: lax.bool().default(() => (false)),
  skills: z.array(z.string()).default(() => []),
  cached: lax.bool().default(() => (false)),
};
export const PreflightSchema = model("Preflight", PreflightFields);
export type Preflight = z.output<typeof PreflightSchema>;

export const EmployeeFields = {
  id: z.string().min(1).max(64).regex(new RegExp("^[a-zA-Z0-9_-]+$")),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(2000),
  model_id: z.string(),
  capabilities: z.array(z.string()).min(1).max(6),
  skills: z.array(z.string()).max(6).default(() => []),
  skill_tools: z.array(z.string()).max(12).default(() => []),
  skill_context: z.string().default(() => ("" as const)),
  reason: z.string().max(1000).default(() => ("" as const)),
};
export const EmployeeSchema = model("Employee", EmployeeFields);
export type Employee = z.output<typeof EmployeeSchema>;

export const PlanChoiceFields = {
  question: z.string(),
  assumed: z.string(),
  alternative: z.string().default(() => ("" as const)),
};
export const PlanChoiceSchema = model("PlanChoice", PlanChoiceFields);
export type PlanChoice = z.output<typeof PlanChoiceSchema>;

// A declared artifact the user took out of the delivery (an answered question, `diagnosis_id`): it is no
// longer required, fingerprinted or compared, and never counts as evidence (contracts.waived).
export const ArtifactWaiverFields = {
  path: z.string().min(1),
  reason: z.string().default(() => ("" as const)),
  diagnosis_id: z.string(),
  created_at: lax.datetime().default(nowIso),
};
export const ArtifactWaiverSchema = model("ArtifactWaiver", ArtifactWaiverFields);
export type ArtifactWaiver = z.output<typeof ArtifactWaiverSchema>;

export const TaskPlanFields = {
  summary: z.string(),
  nodes: z.array(TaskNodeSchema),
  parts: z.array(PlanPartSchema).default(() => []),
  employees: z.array(EmployeeSchema).max(12).default(() => []),
  team_brief: z.string().default(() => ("" as const)),
  request: z.string().default(() => ("" as const)),
  in_project: lax.bool().default(() => (false)),
  requires: z.array(z.string()).default(() => []),
  folder: z.string().default(() => ("" as const)),
  title: z.string().default(() => ("" as const)),
  estimate: CostEstimateSchema.nullable().default(() => (null)),
  planning_method: z.string().default(() => ("heuristic" as const)),
  planner_model_id: z.string().nullable().default(() => (null)),
  planning_cost_usd: lax.number().default(() => (0.0)),
  planning_note: z.string().nullable().default(() => (null)),
  choices: z.array(PlanChoiceSchema).default(() => []),
  artifact_waivers: z.array(ArtifactWaiverSchema).default(() => []),
};
export const TaskPlanSchema = model("TaskPlan", TaskPlanFields);
export type TaskPlan = z.output<typeof TaskPlanSchema>;

export const AttachmentFields = {
  id: z.string(),
  name: z.string(),
  size: lax.int(),
  kind: z.string(),
  media_type: z.string(),
};
export const AttachmentSchema = model("Attachment", AttachmentFields);
export type Attachment = z.output<typeof AttachmentSchema>;

export const DiagnosisMessageFields = {
  text: z.string(),
  choice: z.string().nullable().default(() => (null)),
  attachments: z.array(AttachmentSchema).default(() => []),
  created_at: lax.datetime().default(nowIso),
};
export const DiagnosisMessageSchema = model("DiagnosisMessage", DiagnosisMessageFields);
export type DiagnosisMessage = z.output<typeof DiagnosisMessageSchema>;

export const DiagnosisFields = {
  id: z.string(),
  trigger: z.string(),
  node_id: z.string().nullable().default(() => (null)),
  decision_id: z.string().nullable().default(() => (null)),
  model_id: z.string().nullable().default(() => (null)),
  status: z.string().default(() => ("running" as const)),
  report: z.string().nullable().default(() => (null)),
  advice: z.string().nullable().default(() => (null)),
  verdict: z.string().nullable().default(() => (null)),
  user_action: z.string().nullable().default(() => (null)),
  scope: z.string().default(() => ("environment" as const)),
  repair_id: z.string().nullable().default(() => (null)),
  reply_to: z.string().nullable().default(() => (null)),
  question: z.string().nullable().default(() => (null)),
  choices: z.array(z.string()).default(() => []),
  messages: z.array(DiagnosisMessageSchema).default(() => []),
  error: z.string().nullable().default(() => (null)),
  cost_usd: lax.number().default(() => (0.0)),
  created_at: lax.datetime().default(nowIso),
  finished_at: lax.datetime().nullable().default(() => (null)),
};
export const DiagnosisSchema = model("Diagnosis", DiagnosisFields);
export type Diagnosis = z.output<typeof DiagnosisSchema>;

export const DecisionFields = {
  id: z.string().default(() => newId(8)),
  node_id: z.string().nullable().default(() => (null)),
  event: z.string(),
  action: z.string(),
  reason: z.string().default(() => ("" as const)),
  instructions: z.string().nullable().default(() => (null)),
  model_id: z.string().nullable().default(() => (null)),
  targets: z.array(z.string()).default(() => []),
  lead_model_id: z.string().nullable().default(() => (null)),
  engineer_job_id: z.string().nullable().default(() => (null)),
  summary: z.string().nullable().default(() => (null)),
  created_at: lax.datetime().default(nowIso),
};
export const DecisionSchema = model("Decision", DecisionFields);
export type Decision = z.output<typeof DecisionSchema>;

export const LeadThinkingFields = {
  event: z.string(),
  node_id: z.string().nullable().default(() => (null)),
  started_at: lax.datetime().default(nowIso),
};
export const LeadThinkingSchema = model("LeadThinking", LeadThinkingFields);
export type LeadThinking = z.output<typeof LeadThinkingSchema>;

export const LeadMessageFields = {
  id: z.string().default(() => newId(8)),
  role: z.string(),
  text: z.string().default(() => ("" as const)),
  status: z.string().default(() => ("done" as const)),
  engineer_job_id: z.string().nullable().default(() => (null)),
  attachments: z.array(AttachmentSchema).default(() => []),
  created_at: lax.datetime().default(nowIso),
};
export const LeadMessageSchema = model("LeadMessage", LeadMessageFields);
export type LeadMessage = z.output<typeof LeadMessageSchema>;

export const SupervisorSessionFields = {
  model_id: z.string().nullable().default(() => (null)),
  reasoning_effort: z.string().nullable().default(() => (null)),
  session_id: z.string().nullable().default(() => (null)),
  cwd: z.string().nullable().default(() => (null)),
  history: z.array(z.record(z.string(), z.any())).default(() => []),
  calls: lax.int().default(() => (0)),
  previous: z.array(z.string()).default(() => []),
  started_at: lax.datetime().default(nowIso),
};
export const SupervisorSessionSchema = model("SupervisorSession", SupervisorSessionFields);
export type SupervisorSession = z.output<typeof SupervisorSessionSchema>;

export const EngineerMessageFields = {
  role: z.string(),
  text: z.string(),
  attachments: z.array(AttachmentSchema).default(() => []),
  created_at: lax.datetime().default(nowIso),
};
export const EngineerMessageSchema = model("EngineerMessage", EngineerMessageFields);
export type EngineerMessage = z.output<typeof EngineerMessageSchema>;

export const EngineerJobFields = {
  id: z.string().default(() => newId(10)),
  kind: z.string().default(() => ("component" as const)),
  origin: z.string().default(() => ("user" as const)),
  title: z.string().default(() => ("" as const)),
  headline: z.string().default(() => ("" as const)),
  plan_plain: z.string().default(() => ("" as const)),
  plain: z.string().default(() => ("" as const)),
  thread_id: z.string().nullable().default(() => (null)),
  context: z.string().default(() => ("" as const)),
  attachments: z.array(AttachmentSchema).default(() => []),
  request: z.string(),
  status: z.string().default(() => ("queued" as const)),
  phase: z.string().default(() => ("plan" as const)),
  plan: z.string().nullable().default(() => (null)),
  report: z.string().nullable().default(() => (null)),
  question: z.string().nullable().default(() => (null)),
  choices: z.array(z.string()).default(() => []),
  run_id: z.string().nullable().default(() => (null)),
  node_id: z.string().nullable().default(() => (null)),
  decision_id: z.string().nullable().default(() => (null)),
  diagnosis_id: z.string().nullable().default(() => (null)),
  improvement_id: z.string().nullable().default(() => (null)),
  repair_id: z.string().nullable().default(() => (null)),
  files: z.array(z.string()).default(() => []),
  checks: z.array(z.string()).default(() => []),
  diff: z.string().nullable().default(() => (null)),
  commit: z.string().nullable().default(() => (null)),
  model_id: z.string().nullable().default(() => (null)),
  messages: z.array(EngineerMessageSchema).default(() => []),
  budget_usd: lax.number().default(() => (2.0)),
  cost_usd: lax.number().default(() => (0.0)),
  error: z.string().nullable().default(() => (null)),
  created_at: lax.datetime().default(nowIso),
  updated_at: lax.datetime().default(nowIso),
  finished_at: lax.datetime().nullable().default(() => (null)),
};
export const EngineerJobSchema = model("EngineerJob", EngineerJobFields);
export type EngineerJob = z.output<typeof EngineerJobSchema>;

export const LearningSettingsFields = {
  enabled: lax.bool().default(() => (false)),
  budget_usd: lax.number(z.number().min(0).max(100)).default(() => (0.5)),
};
export const LearningSettingsSchema = model("LearningSettings", LearningSettingsFields);
export type LearningSettings = z.output<typeof LearningSettingsSchema>;

export const LearningReviewFields = {
  run_id: z.string(),
  revision: z.string(),
  status: z.string().default(() => ("queued" as const)),
  automatic: lax.bool().default(() => (true)),
  conclusion: z.string().default(() => ("" as const)),
  model_id: z.string().nullable().default(() => (null)),
  budget_usd: lax.number().default(() => (0.5)),
  cost_usd: lax.number().default(() => (0)),
  allocated_usd: lax.number().default(() => (0)),
  error: z.string().nullable().default(() => (null)),
  created_at: lax.datetime().default(nowIso),
};
export const LearningReviewSchema = model("LearningReview", LearningReviewFields);
export type LearningReview = z.output<typeof LearningReviewSchema>;

export const ImprovementFields = {
  id: z.string().default(() => newId(12)),
  run_id: z.string(),
  revision: z.string(),
  kind: z.enum(["skill", "rule", "platform"]),
  title: z.string().min(1).max(160),
  rationale: z.string().min(1).max(2000),
  content: z.string().min(1).max(7000),
  tools: z.array(z.string()).default(() => []),
  capability: z.string().nullable().default(() => (null)),
  source_nodes: z.array(z.string()).default(() => []),
  problem_kind: z.string().default(() => ("" as const)),
  problem_key: z.string().default(() => ("" as const)),
  check: z.string().max(4000).default(() => ("" as const)),
  status: z.string().default(() => ("proposed" as const)),
  validation: z.record(z.string(), z.any()).default(() => ({})),
  baseline: z.record(z.string(), z.any()).default(() => ({})),
  engineer_job_id: z.string().nullable().default(() => (null)),
  applied_at: lax.datetime().nullable().default(() => (null)),
  created_at: lax.datetime().default(nowIso),
};
export const ImprovementSchema = model("Improvement", ImprovementFields);
export type Improvement = z.output<typeof ImprovementSchema>;

export const CapabilityCardFields = {
  name: z.string(),
  kind: z.string().default(() => ("tool" as const)),
  summary: z.string().default(() => ("" as const)),
  usage: z.string().default(() => ("" as const)),
  guide: z.string().default(() => ("" as const)),
  files: z.array(z.string()).default(() => []),
  check: z.string().default(() => ("" as const)),
  secrets: z.array(z.string()).default(() => []),
  domains: z.array(z.string()).default(() => []),
};
export const CapabilityCardSchema = model("CapabilityCard", CapabilityCardFields);
export type CapabilityCard = z.output<typeof CapabilityCardSchema>;

export const CapabilityProposalFields = {
  name: z.string(),
  kind: z.string().default(() => ("tool" as const)),
  summary: z.string().default(() => ("" as const)),
  usage: z.string().default(() => ("" as const)),
  guide: z.string().default(() => ("" as const)),
  files: z.array(z.string()).default(() => []),
  check: z.string().default(() => ("" as const)),
  secrets: z.array(z.string()).default(() => []),
  domains: z.array(z.string()).default(() => []),
  status: z.string().default(() => ("proposed" as const)),
  capability_id: z.string().nullable().default(() => (null)),
};
export const CapabilityProposalSchema = model("CapabilityProposal", CapabilityProposalFields);
export type CapabilityProposal = z.output<typeof CapabilityProposalSchema>;

export const CapabilityFields = {
  name: z.string(),
  kind: z.string().default(() => ("tool" as const)),
  summary: z.string().default(() => ("" as const)),
  usage: z.string().default(() => ("" as const)),
  guide: z.string().default(() => ("" as const)),
  files: z.array(z.string()).default(() => []),
  check: z.string().default(() => ("" as const)),
  secrets: z.array(z.string()).default(() => []),
  domains: z.array(z.string()).default(() => []),
  id: z.string(),
  status: z.string().default(() => ("active" as const)),
  source_run_id: z.string().nullable().default(() => (null)),
  check_ok: lax.bool().nullable().default(() => (null)),
  check_output: z.string().default(() => ("" as const)),
  created_at: lax.datetime().default(nowIso),
  source: z.string().default(() => ("task" as const)),
  version: z.string().default(() => ("" as const)),
  entry: z.string().default(() => ("" as const)),
  // A service package: the capabilities it gives FluidForm itself (services.ts), and what any package
  // needs to be there first.
  provides: z.array(z.string()).default(() => []),
  requires: z.array(z.string()).default(() => []),
  // An interface package: the folder of its web page (index.html and what it loads), served by FluidForm.
  site: z.string().default(() => ("" as const)),
};
export const CapabilitySchema = model("Capability", CapabilityFields);
export type Capability = z.output<typeof CapabilitySchema>;

export const ExecutionRunFields = {
  id: z.string(),
  prompt: z.string(),
  status: RunStatus,
  plan: TaskPlanSchema,
  kind: z.string().default(() => ("task" as const)),
  auto_routed: lax.bool().default(() => (false)),
  origin: z.record(z.string(), z.any()).nullable().default(() => (null)),
  capability_proposals: z.array(CapabilityProposalSchema).default(() => []),
  budget_usd: lax.number(),
  use_cli: lax.bool().default(() => (true)),
  // The models its steps and its lead may use, as asked for (the command line's --model); empty: any.
  only_models: z.array(z.string()).default(() => []),
  // Only membership CLIs (--only-cli); use_cli false is only API models.
  cli_only: lax.bool().default(() => (false)),
  allow_network: lax.bool().default(() => (false)),
  project_dir: z.string().nullable().default(() => (null)),
  attachments: z.array(AttachmentSchema).default(() => []),
  lead_seen_attachments: z.array(z.string()).nullable().default(() => (null)),
  // A chat's older turns, summarised: up to the message ``until`` (the chat package's compaction).
  chat_summary: z.object({ text: z.string(), until: z.string() }).nullish(),
  rework_rounds: lax.int().default(() => (0)),
  github_url: z.string().nullable().default(() => (null)),
  diagnoses: z.array(DiagnosisSchema).default(() => []),
  supervisor: SupervisorSessionSchema.nullable().default(() => (null)),
  decisions: z.array(DecisionSchema).default(() => []),
  lead_messages: z.array(LeadMessageSchema).default(() => []),
  lead_thinking: LeadThinkingSchema.nullable().default(() => (null)),
  decisions_since: lax.datetime().nullable().default(() => (null)),
  maintenance_id: z.string().nullable().default(() => (null)),
  engineer_job_id: z.string().nullable().default(() => (null)),
  engineer_seen: z.record(z.string(), z.string()).default(() => ({})),
  waiting_diagnosis_id: z.string().nullable().default(() => (null)),
  parent_run_id: z.string().nullable().default(() => (null)),
  workspace_id: z.string().nullable().default(() => (null)),
  folder_name: z.string().nullable().default(() => (null)),
  background: z.string().nullable().default(() => (null)),
  preflight: PreflightSchema.nullable().default(() => (null)),
  improvement_uses: z.array(z.record(z.string(), z.any())).default(() => []),
  improvements_prepared: lax.bool().default(() => (false)),
  actual_cost_usd: lax.number().default(() => (0.0)),
  created_at: lax.datetime().default(nowIso),
  updated_at: lax.datetime().default(nowIso),
  final_result: z.string().nullable().default(() => (null)),
  error: z.string().nullable().default(() => (null)),
};
export const ExecutionRunSchema = model("ExecutionRun", ExecutionRunFields);
export type ExecutionRun = z.output<typeof ExecutionRunSchema>;

export const EventFields = {
  id: lax.int().nullable().default(() => (null)),
  run_id: z.string(),
  kind: z.string(),
  data: z.record(z.string(), z.any()).default(() => ({})),
  created_at: lax.datetime().default(nowIso),
};
export const EventSchema = model("Event", EventFields);
export type Event = z.output<typeof EventSchema>;

