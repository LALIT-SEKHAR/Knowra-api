import {
  XAI_BASE_URL,
  type ChatProviderId,
} from '../../config/chatProviders.js';
import { AppError } from '../../utils/errors.js';
import { createOpenAIClient, estimateTokens, withRateLimitRetry, type TokenUsage } from '../openai/client.js';

/** High enough that the same question is phrased differently, low enough to stay accurate. */
const CHAT_TEMPERATURE = 0.8;

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatGenerationParams = {
  provider: ChatProviderId;
  model: string;
  system: string;
  messages: ChatMessage[];
  apiKey: string;
  /** Required for custom provider */
  baseUrl?: string | null;
  temperature?: number;
  maxTokens?: number;
};

export type ChatGenerationResult = {
  content: string;
  usage: TokenUsage;
};

function estimateChatUsage(params: ChatGenerationParams, content: string): TokenUsage {
  const prompt =
    params.system.length +
    params.messages.reduce((sum, m) => sum + m.content.length, 0);
  const promptTokens = estimateTokens('x'.repeat(prompt));
  const completionTokens = estimateTokens(content);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function providerError(provider: ChatProviderId, detail?: string): AppError {
  const label =
    provider === 'anthropic'
      ? 'Claude'
      : provider === 'google'
        ? 'Gemini'
        : provider === 'xai'
          ? 'Grok'
          : provider === 'custom'
            ? 'Custom'
            : 'OpenAI';
  return new AppError(
    detail?.trim()
      ? `${label} chat failed: ${detail.trim()}`
      : `Failed to generate answer with ${label}`,
    502,
  );
}

async function generateOpenAICompatible(
  params: ChatGenerationParams,
  baseURL?: string,
): Promise<ChatGenerationResult> {
  const client = createOpenAIClient(params.apiKey, baseURL);
  try {
    const response = await withRateLimitRetry(() =>
      client.chat.completions.create({
        model: params.model,
        temperature: params.temperature ?? CHAT_TEMPERATURE,
        ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
        messages: [{ role: 'system', content: params.system }, ...params.messages],
      }),
    );
    const content = response.choices[0]?.message?.content;
    if (!content) throw providerError(params.provider);
    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens ?? 0,
          completionTokens: response.usage.completion_tokens ?? 0,
          totalTokens:
            response.usage.total_tokens ??
            (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
        }
      : estimateChatUsage(params, content);
    if (usage.totalTokens === 0) {
      return { content, usage: estimateChatUsage(params, content) };
    }
    return { content, usage };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : undefined;
    const lower = (message ?? '').toLowerCase();
    if (
      lower.includes('incorrect api key') ||
      lower.includes('invalid api key') ||
      lower.includes('401') ||
      lower.includes('authentication') ||
      lower.includes('unauthorized')
    ) {
      const where =
        params.provider === 'xai'
          ? 'your xAI (Grok) key'
          : params.provider === 'custom'
            ? 'your custom endpoint key'
            : 'your OpenAI API key';
      throw new AppError(
        `${where.charAt(0).toUpperCase()}${where.slice(1)} was rejected. Open Settings → AI, paste a valid key, and save.`,
        400,
      );
    }
    throw providerError(params.provider, message);
  }
}

async function generateAnthropic(params: ChatGenerationParams): Promise<ChatGenerationResult> {
  const history = params.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      temperature: params.temperature ?? CHAT_TEMPERATURE,
      system: params.system,
      messages: history.length > 0 ? history : [{ role: 'user', content: 'Hello' }],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  if (!response.ok) {
    throw providerError('anthropic', data.error?.message || `HTTP ${response.status}`);
  }

  const text = data.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw providerError('anthropic');

  const promptTokens = data.usage?.input_tokens ?? 0;
  const completionTokens = data.usage?.output_tokens ?? 0;
  const usage =
    promptTokens + completionTokens > 0
      ? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        }
      : estimateChatUsage(params, text);

  return { content: text, usage };
}

async function generateGemini(params: ChatGenerationParams): Promise<ChatGenerationResult> {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const message of params.messages) {
    if (message.role === 'system') continue;
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.system }] },
      contents,
      generationConfig: {
        temperature: params.temperature ?? CHAT_TEMPERATURE,
        ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  if (!response.ok) {
    throw providerError('google', data.error?.message || `HTTP ${response.status}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw providerError('google');

  const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
  const usage =
    totalTokens > 0
      ? { promptTokens, completionTokens, totalTokens }
      : estimateChatUsage(params, text);

  return { content: text, usage };
}

export async function generateChatAnswer(
  params: ChatGenerationParams,
): Promise<ChatGenerationResult> {
  switch (params.provider) {
    case 'openai':
      return generateOpenAICompatible(params);
    case 'xai':
      return generateOpenAICompatible(params, XAI_BASE_URL);
    case 'custom': {
      const baseUrl = params.baseUrl?.trim();
      if (!baseUrl) {
        throw new AppError('Add a custom API base URL in Settings', 400);
      }
      return generateOpenAICompatible(params, baseUrl.replace(/\/$/, ''));
    }
    case 'anthropic':
      return generateAnthropic(params);
    case 'google':
      return generateGemini(params);
    default:
      throw new AppError('Unsupported chat provider', 400);
  }
}

export async function validateChatProviderKey(
  provider: Exclude<ChatProviderId, 'openai'>,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  try {
    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new AppError('Invalid Anthropic API key', 400);
      }
      // 400 on tiny request can still mean the key is accepted
      if (response.status >= 500) {
        throw new AppError('Could not validate Anthropic API key', 400);
      }
      return;
    }

    if (provider === 'google') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new AppError('Invalid Google AI API key', 400);
      }
      return;
    }

    if (provider === 'xai') {
      await createOpenAIClient(apiKey, XAI_BASE_URL).models.list();
      return;
    }

    if (provider === 'custom') {
      const cleaned = baseUrl?.trim().replace(/\/$/, '');
      if (!cleaned) throw new AppError('Custom base URL is required', 400);
      try {
        new URL(cleaned);
      } catch {
        throw new AppError('Custom base URL must be a valid URL', 400);
      }
      // Many local/compatible servers need no key — only validate when one is provided.
      if (apiKey.trim()) {
        try {
          await createOpenAIClient(apiKey, cleaned).models.list();
        } catch {
          // Some servers don't expose /models; URL + key format is still accepted.
        }
      }
      return;
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const label =
      provider === 'anthropic'
        ? 'Anthropic'
        : provider === 'google'
          ? 'Google'
          : provider === 'xai'
            ? 'xAI'
            : 'Custom';
    throw new AppError(`Invalid ${label} API key`, 400);
  }
}
