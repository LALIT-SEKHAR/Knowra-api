export const DEFAULT_CHAT_PROVIDER = 'openai' as const;
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';

export const CHAT_PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Uses your OpenAI key (same as PDF processing).',
    needsSeparateKey: false,
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        description: 'Fast and affordable — good default.',
      },
      {
        id: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini',
        description: 'Stronger answers, still cost-friendly.',
      },
      {
        id: 'gpt-4.1',
        label: 'GPT-4.1',
        description: 'Best OpenAI quality for hard documents.',
      },
      {
        id: 'gpt-5-mini',
        label: 'GPT-5 mini',
        description: 'Stronger reasoning; slower and costlier.',
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude',
    description: 'Anthropic Claude — add your Anthropic API key.',
    needsSeparateKey: true,
    models: [
      {
        id: 'claude-haiku-4-5',
        label: 'Haiku 4.5',
        description: 'Fastest Claude — great everyday chat.',
      },
      {
        id: 'claude-sonnet-4-5',
        label: 'Sonnet 4.5',
        description: 'Balanced quality and speed.',
      },
      {
        id: 'claude-opus-4-5',
        label: 'Opus 4.5',
        description: 'Highest Claude quality for hard questions.',
      },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    description: 'Google Gemini — add your Google AI Studio key.',
    needsSeparateKey: true,
    models: [
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: 'Fast and affordable.',
      },
      {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        description: 'Stronger reasoning and longer context.',
      },
    ],
  },
  {
    id: 'xai',
    label: 'Grok',
    description: 'xAI Grok — add your xAI API key.',
    needsSeparateKey: true,
    models: [
      {
        id: 'grok-3-mini',
        label: 'Grok 3 mini',
        description: 'Faster, lower-cost Grok.',
      },
      {
        id: 'grok-3',
        label: 'Grok 3',
        description: 'Full Grok quality for chat.',
      },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAI-compatible API. Key optional.',
    needsSeparateKey: true,
    models: [],
  },
] as const;

export type ChatProviderId = (typeof CHAT_PROVIDERS)[number]['id'];

export const CHAT_PROVIDER_IDS = CHAT_PROVIDERS.map((p) => p.id) as [
  ChatProviderId,
  ...ChatProviderId[],
];

export function isChatProviderId(value: string): value is ChatProviderId {
  return (CHAT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getChatProvider(id: string) {
  return CHAT_PROVIDERS.find((p) => p.id === id);
}

export function defaultModelForProvider(provider: ChatProviderId): string {
  const p = getChatProvider(provider);
  if (!p || p.models.length === 0) return DEFAULT_CHAT_MODEL;
  return p.models[0].id;
}

export function resolveChatSelection(
  provider?: string | null,
  model?: string | null,
): { provider: ChatProviderId; model: string } {
  const resolvedProvider = provider && isChatProviderId(provider) ? provider : DEFAULT_CHAT_PROVIDER;
  const catalog = getChatProvider(resolvedProvider);

  if (resolvedProvider === 'custom') {
    const customModel = (model ?? '').trim();
    return {
      provider: 'custom',
      model: customModel || 'gpt-4o-mini',
    };
  }

  const allowed = new Set<string>((catalog?.models ?? []).map((m) => m.id));
  if (model && allowed.has(model)) {
    return { provider: resolvedProvider, model };
  }

  return {
    provider: resolvedProvider,
    model: defaultModelForProvider(resolvedProvider),
  };
}

export const XAI_BASE_URL = 'https://api.x.ai/v1';
