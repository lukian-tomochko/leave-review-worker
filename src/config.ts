// Чиста функція: зі змінних середовища → як запускати працівника. Нічого не викликає і не друкує ключів.

/** Безкоштовні моделі OpenRouter з підтримкою tools (список на 04.11.2026; перевіряйте перед запуском). */
export const OPENROUTER_FREE = {
  agentic: "nvidia/nemotron-3-ultra-550b-a55b:free",
  fallbacks: ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free"],
  haikuClass: "nvidia/nemotron-3.5-lightning:free",
  subagent: "nvidia/nemotron-3.5-super-vl:free",
} as const;

export type Provider = "anthropic" | "openrouter";

export type RunConfig = {
  provider: Provider;
  supported: boolean;
  model: string;
  fallbackModel?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Змінні, які додаються ПОВЕРХ process.env для процесу Claude Code (options.env замінює середовище повністю). */
  extraEnv: Record<string, string>;
  /** options.thinking для шлюзу: не-Claude моделі можуть не приймати adaptive thinking. */
  disableThinking: boolean;
  warnings: string[];
};

export type ConfigResult = { ok: true; config: RunConfig } | { ok: false; error: string };

type Env = Record<string, string | undefined>;

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} має бути додатним числом, а не «${raw}»`);
  return n;
}

export function resolveConfig(env: Env): ConfigResult {
  const provider = (env.WORKER_PROVIDER ?? "anthropic").trim().toLowerCase();
  let maxTurns: number;
  let maxBudgetUsd: number;
  try {
    maxTurns = Math.floor(positive(env.WORKER_MAX_TURNS, 12, "WORKER_MAX_TURNS"));
    maxBudgetUsd = positive(env.WORKER_MAX_BUDGET_USD, 0.2, "WORKER_MAX_BUDGET_USD");
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      return { ok: false, error: "немає ANTHROPIC_API_KEY (варіант A) — додайте його в .env або оберіть WORKER_PROVIDER=openrouter" };
    }
    return {
      ok: true,
      config: {
        provider: "anthropic",
        supported: true,
        model: env.WORKER_MODEL?.trim() || "haiku",
        maxTurns,
        maxBudgetUsd,
        extraEnv: {},
        disableThinking: false,
        warnings: [],
      },
    };
  }

  if (provider === "openrouter") {
    const key = env.OPENROUTER_API_KEY;
    if (!key) return { ok: false, error: "немає OPENROUTER_API_KEY (варіант B) — створіть безкоштовний ключ на openrouter.ai" };
    const model = env.WORKER_MODEL?.trim() || OPENROUTER_FREE.agentic;
    const warnings = [
      "ЕКСПЕРИМЕНТ, офіційно не підтримується: Anthropic не підтримує маршрутизацію Claude Code на не-Claude моделі через шлюзи.",
      "total_cost_usd і maxBudgetUsd рахуються за цінами Claude, а не OpenRouter: це не стеля витрат. Ліміт — у налаштуваннях ключа OpenRouter.",
      "Безкоштовний рівень OpenRouter: 20 запитів/хв і 50 на добу на акаунт; один запуск агента — це кілька запитів.",
    ];
    if (!model.endsWith(":free")) warnings.push(`модель ${model} не :free — запити будуть платними`);
    // Підказка без значення ключа: ключі OpenRouter починаються з «sk-or-»; лапки чи пробіли навколо ламають автентифікацію.
    if (key !== key.trim() || /^["']|["']$/.test(key)) warnings.push("OPENROUTER_API_KEY має пробіли чи лапки навколо значення — приберіть їх у .env");
    else if (!key.startsWith("sk-or-")) warnings.push("OPENROUTER_API_KEY не починається з «sk-or-»: схоже, це не ключ OpenRouter (перевірте .env)");
    return {
      ok: true,
      config: {
        provider: "openrouter",
        supported: false,
        model,
        fallbackModel: OPENROUTER_FREE.fallbacks.join(","),
        maxTurns,
        maxBudgetUsd,
        extraEnv: {
          ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
          ANTHROPIC_AUTH_TOKEN: key,
          // Має бути саме порожнім: інакше Claude Code спробує ключ Anthropic замість токена OpenRouter.
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_DEFAULT_FABLE_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: OPENROUTER_FREE.haikuClass,
          CLAUDE_CODE_SUBAGENT_MODEL: OPENROUTER_FREE.subagent,
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        },
        disableThinking: true,
        warnings,
      },
    };
  }

  return { ok: false, error: `WORKER_PROVIDER має бути anthropic або openrouter, а не «${provider}»` };
}

/**
 * Середовище для процесу Claude Code: копія базового без чужої авторизації.
 * Якщо працівника запущено з сесії Claude Code (чи іншого агента), вона лишає в середовищі службові змінні
 * (CLAUDE_CODE_*, USE_*_OAUTH, …); підпроцес вважає себе дочірнім сеансом хоста і шле токен хоста замість ключа
 * OpenRouter — відповідь «401 this is not an OpenRouter API key». Тому прибираємо їх і чужі ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN. ANTHROPIC_API_KEY лишаємо: це ключ варіанта A з .env, а для OpenRouter його перекриває порожній.
 */
const FOREIGN_AUTH = /^(CLAUDE|USE_(LOCAL|STAGING)_OAUTH$|ANTHROPIC_(BASE_URL|AUTH_TOKEN)$)/i;

export function cleanEnv(base: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !FOREIGN_AUTH.test(k)));
}

/** Опис конфігурації для --dry-run: без значень ключів. */
export function describeConfig(c: RunConfig): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.extraEnv)) {
    env[k] = /TOKEN|KEY/.test(k) ? (v ? "<задано>" : "<порожньо>") : v;
  }
  return { ...c, extraEnv: env };
}
