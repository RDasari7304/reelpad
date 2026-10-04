import { config } from "../../config.js";

/**
 * Calls the Claude Messages API with structured outputs (output_config.format = json_schema),
 * so the reply is always JSON matching `schema`. Newer models don't accept a forced tool_choice,
 * which is what earlier versions of this file used.
 */
export async function structured<T>(opts: {
  system: string;
  user: string;
  /** Short name for what's being produced; used in error messages. */
  toolName: string;
  /** One-line description of the expected output; appended to the instructions. */
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Public image URLs to show Claude along with the prompt. */
  images?: string[];
  /** Overrides ANTHROPIC_MODEL for this call. */
  model?: string;
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
      model: opts.model ?? config.ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 4000,
      system: opts.system,
      messages: [
        {
          role: "user",
          content: [
            ...(opts.images ?? []).map((url) => ({ type: "image", source: { type: "url", url } })),
            { type: "text", text: `${opts.user}\n\nRespond with: ${opts.toolDescription}` },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: opts.schema } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }>; stop_reason?: string };
  const text = json.content.find((c) => c.type === "text" && c.text)?.text;
  if (!text) throw new Error(`Claude returned no ${opts.toolName} output (stop reason: ${json.stop_reason ?? "unknown"})`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude returned invalid JSON for ${opts.toolName} (stop reason: ${json.stop_reason ?? "unknown"})`);
  }
}
