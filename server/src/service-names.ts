// The capabilities a service package can give FluidForm itself (docs/design/chat-and-pricing-packages.md).
export const PROVIDABLE = new Set(["chat", "pricing", "planning", "team", "lead", "review", "diagnosis", "engineer", "learning", "preflight", "skills", "research"]);

/** What each is called on the page. */
export const LABELS: Record<string, string> = { chat: "聊天", pricing: "计价", planning: "规划", team: "员工", lead: "负责人", review: "验收",
  diagnosis: "诊断", engineer: "平台工程师", learning: "复盘与经验", preflight: "执行前检查", skills: "技能", research: "模型调研" };
