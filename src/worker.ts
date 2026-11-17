// Запуск працівника: node src/worker.ts [--dry-run] [--set clean|problems|injection]
//   --dry-run  показує конфігурацію, заявки, прапорці й перевірку меж БЕЗ виклику моделі (ключ не потрібен).
// Коди виходу: 0 — відповідь пройшла перевіряльник; 1 — перевіряльник знайшов проблеми; 2 — помилка запуску.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describeConfig, resolveConfig } from "./config.ts";
import { loadSet } from "./data.ts";
import { checkWritePath } from "./guard.ts";
import { OUT_DIR, REVIEW_TOOL, buildOptions, buildPrompt } from "./options.ts";
import { reviewJsonSchema, verifyReview } from "./report.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const setIdx = args.indexOf("--set");
const setName = setIdx >= 0 ? (args[setIdx + 1] ?? "") : "problems";
const cwd = process.cwd();
const dataDir = path.resolve(cwd, "data");
// Локальна дата у форматі РРРР-ММ-ДД (шведська локаль якраз так її пише).
const today = new Date().toLocaleDateString("sv-SE");
const denials: string[] = [];
const log = (line: string) => {
  denials.push(line);
  console.error(line);
};

async function dry(): Promise<number> {
  console.log("=== DRY RUN: модель не викликається ===");
  const resolved = resolveConfig(process.env);
  if (resolved.ok) {
    const { warnings, ...shown } = describeConfig(resolved.config);
    console.log("Конфігурація:", JSON.stringify(shown, null, 2));
    for (const w of warnings as string[]) console.log("УВАГА:", w);
  } else {
    console.log("Конфігурація: не готова —", resolved.error, "(для --dry-run це нормально)");
  }
  const set = await loadSet(dataDir, setName);
  console.log(`Набір ${set.name}: ${set.requests.length} заявок`);
  for (const c of set.checks) console.log(`  ${c.id}: ${c.days} дн., прапорці [${c.flags.join(", ") || "—"}]`);
  console.log("Інструменти: існують [Write] + MCP", REVIEW_TOOL, "; без питань:", [REVIEW_TOOL, "Write"].join(", "));
  console.log("Межа запису (хук PreToolUse):");
  for (const p of [`${OUT_DIR}/${today}-review-${setName}.md`, "../secrets.txt", "src/worker.ts", "C:/Windows/x.txt", "/etc/passwd"]) {
    const c = checkWritePath(p, cwd, OUT_DIR);
    console.log(`  ${c.ok ? "дозволено" : "ВІДМОВА  "}  ${p}`);
  }
  const schema = reviewJsonSchema() as { properties?: Record<string, unknown> };
  console.log("Схема результату, поля:", Object.keys(schema.properties ?? {}).join(", "));
  console.log("Промпт:", buildPrompt(today, setName));
  return 0;
}

async function run(): Promise<number> {
  const resolved = resolveConfig(process.env);
  if (!resolved.ok) {
    console.error("Не можу запустити:", resolved.error);
    return 2;
  }
  const config = resolved.config;
  for (const w of config.warnings) console.error("УВАГА:", w);
  const set = await loadSet(dataDir, setName);
  const options = buildOptions(config, { cwd, dataDir, setName, log, baseEnv: process.env });

  let result: SDKResultMessage | undefined;
  try {
    for await (const msg of query({ prompt: buildPrompt(today, setName), options })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") log(`→ ${block.name}`);
        }
      } else if (msg.type === "result") {
        result = msg;
      }
    }
  } catch (e) {
    // query() кидає помилку після результату-помилки (ліміт кроків, бюджет, недоступна модель…).
    console.error("Запуск перервано:", (e as Error).message);
  }

  await mkdir(path.join(cwd, OUT_DIR, "runs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runFile = path.join(OUT_DIR, "runs", `${stamp}-${setName}.json`);
  const guardDenials = denials.filter((l) => l.startsWith("ВІДМОВА"));

  if (!result) {
    console.error("Результату немає. Перевірте ключ, модель і ліміти.");
    return 2;
  }
  const base = {
    set: setName,
    provider: config.provider,
    model: config.model,
    subtype: result.subtype,
    num_turns: result.num_turns,
    total_cost_usd_estimate: result.total_cost_usd,
    guard_denials: guardDenials,
  };
  if (result.subtype !== "success") {
    await writeFile(runFile, JSON.stringify({ ...base, errors: result.errors }, null, 2));
    console.error(`Зупинено: ${result.subtype}. Деталі: ${runFile}`);
    return 2;
  }
  let verdict = verifyReview(result.structured_output, set.checks, cwd, OUT_DIR);
  if (verdict.ok) {
    // Модель могла сказати «записав», а запису не було (пропустила Write або хук відмовив); звіт має згадувати кожен id.
    const file = path.resolve(cwd, verdict.report.report_file);
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) {
      verdict = { ok: false, problems: [`файлу звіту ${verdict.report.report_file} немає на диску`] };
    } else {
      const missing = set.requests.filter((r) => !text.includes(r.id)).map((r) => r.id);
      if (missing.length) verdict = { ok: false, problems: [`у звіті не згадано: ${missing.join(", ")}`] };
    }
  }
  await writeFile(runFile, JSON.stringify({ ...base, verdict }, null, 2));
  if (verdict.ok) {
    console.log(`ПЕРЕВІРЕНО: набір ${setName}, ${verdict.report.items.length} заявок, статус ${verdict.report.status}.`);
    console.log(verdict.report.summary);
    console.log(`Звіт для менеджера: ${verdict.report.report_file}; запуск: ${runFile}`);
    return 0;
  }
  console.log("ПРОБЛЕМИ (перевіряльник у коді):");
  for (const p of verdict.problems) console.log(" -", p);
  console.log(`Запуск: ${runFile}`);
  return 1;
}

try {
  process.exitCode = dryRun ? await dry() : await run();
} catch (e) {
  console.error("Помилка:", (e as Error).message);
  process.exitCode = 2;
}
