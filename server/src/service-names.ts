// The capabilities a service package can give FluidForm itself (docs/design/chat-and-pricing-packages.md).
export const PROVIDABLE = new Set(["chat", "pricing"]);

/** What each is called on the page. */
export const LABELS: Record<string, string> = { chat: "聊天", pricing: "计价" };
