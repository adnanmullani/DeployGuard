import { AiReview, Finding, Risk } from './types';

export type Provider = 'gemini' | 'anthropic' | 'openai';

export const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: 'gemini-3.8-flash',
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4o-mini',
};

const SYSTEM = `You are a senior SRE reviewing a pull request for deployment risk.
You get rule-engine findings, an optional Terraform plan summary and masked diffs of infra files.
Reply with ONLY a JSON object, no markdown fences:
{"risk":"low|medium|high","summary":"2-3 sentences","blastRadius":["what can break or who is affected"],"rollback":["ordered concrete steps"]}
Be specific to the changes. Never invent resources that are not in the input.`;

export function buildPrompt(findings: Finding[], planSummary: string, diff: string): string {
  const f = findings.length ? findings.map((x) => `- [${x.severity}] ${x.title}: ${x.detail}`).join('\n') : '(none)';
  return `RULE FINDINGS:\n${f}\n\nTERRAFORM PLAN:\n${planSummary || '(not provided)'}\n\nDIFF:\n${diff || '(empty)'}`;
}

export async function review(
  provider: Provider,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<AiReview> {
  const text = await callProvider(provider, apiKey, model, prompt);
  return parseReview(text);
}

async function callProvider(provider: Provider, key: string, model: string, prompt: string): Promise<string> {
  if (provider === 'gemini') {
    const res = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': key },
      {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      },
    );
    return res.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  }
  if (provider === 'anthropic') {
    const res = await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: prompt }] },
    );
    return res.content?.map((c: any) => c.text ?? '').join('') ?? '';
  }
  const res = await post(
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${key}` },
    {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    },
  );
  return res.choices?.[0]?.message?.content ?? '';
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [2000, 6000];
const TIMEOUT_MS = 60_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  delays = BACKOFF_MS,
  timeoutMs = TIMEOUT_MS,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // A hung provider must not hang the PR check: give up and let the rules-only result through.
      if (isTimeout(e)) throw new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (attempt < delays.length) {
        await wait(delays[attempt]); // brief network error, try again
        continue;
      }
      throw e;
    }
    if (res.ok) return res.json();
    // Providers return 429/503 during demand spikes; a short wait usually clears it.
    if (RETRYABLE.has(res.status) && attempt < delays.length) {
      await wait(delays[attempt]);
      continue;
    }
    throw new Error(`AI request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

export function parseReview(text: string): AiReview {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI response contained no JSON');
  const raw = JSON.parse(text.slice(start, end + 1));
  const risk = String(raw.risk ?? '').toLowerCase();
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 10) : []);
  return {
    risk: (['low', 'medium', 'high'].includes(risk) ? risk : 'medium') as Risk,
    summary: String(raw.summary ?? '').slice(0, 1200),
    blastRadius: list(raw.blastRadius),
    rollback: list(raw.rollback),
  };
}
