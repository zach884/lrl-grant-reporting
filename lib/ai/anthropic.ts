// lib/ai/anthropic.ts — thin Anthropic (Claude) client for enrichment.
//
// Used by the NAICS enricher to classify a company's 6-digit NAICS code from its descriptive
// text. Cheap model (Haiku), structured JSON output. Reads ANTHROPIC_API_KEY.

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

/** True when Claude is configured (enrichers that need AI skip cleanly otherwise). */
export const hasAnthropic = Boolean(apiKey);

/** Cheap, fast model for classification. Haiku has no thinking/effort params. */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5';

let _client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — AI enrichment unavailable');
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * One-shot structured classification. Sends `system` + `user` and constrains the response to
 * `schema` (JSON Schema) via structured outputs, returning the parsed object (or null on
 * malformed output). Model has no thinking/effort config (Haiku doesn't support them).
 */
export async function classifyJson<T = any>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T | null> {
  const res = await getAnthropic().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: opts.maxTokens ?? 512,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: { type: 'json_schema', schema: opts.schema } },
  } as any);
  const block = res.content.find((b: any) => b.type === 'text') as { text: string } | undefined;
  if (!block?.text) return null;
  try {
    return JSON.parse(block.text) as T;
  } catch {
    return null;
  }
}
