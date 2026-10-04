import { config } from "../../config.js";

/**
 * Calls the Claude Messages API and forces a single tool call so we always get structured JSON back.
 */
export async function structured<T>(opts: {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  // Authorization: Bearer is the current, preferred header and works for every key type
  // (personal sk-ant-usr-… keys, service account keys, and legacy workspace keys).
  // Keys that cover several workspaces also need the workspace ID on every request.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.ANTHROPIC_API_KEY.trim()}`,
    "anthropic-version": "2023-06-01",
  };
  if (config.ANTHROPIC_WORKSPACE_ID) headers["anthropic-workspace-id"] = config.ANTHROPIC_WORKSPACE_ID.trim();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 2000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      tools: [{ name: opts.toolName, description: opts.toolDescription, input_schema: opts.schema }],
      tool_choice: { type: "tool", name: opts.toolName },
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  const json = (await res.json()) as { content: Array<{ type: string; name?: string; input?: unknown }> };
  const block = json.content.find((c) => c.type === "tool_use" && c.name === opts.toolName);
  if (!block?.input) throw new Error("Claude returned no structured output");
  return block.input as T;
}
