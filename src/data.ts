// Завантаження набору й відповідь MCP-інструмента review_data.
// Модель не читає файли сама: набір обирає код (аргумент --set), а шлях модель не передає.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkRequests, parseBalances, parseClosures, parseRequests, type Check, type Request } from "./checks.ts";

export type ReviewSet = { name: string; requests: Request[]; checks: Check[] };

/** Назва набору — лише літери, цифри й дефіс: жодних шляхів. */
export function assertSetName(name: string): void {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`назва набору «${name}» має складатися з a-z, 0-9 і дефіса`);
}

export async function loadSet(dataDir: string, name: string): Promise<ReviewSet> {
  assertSetName(name);
  const [requests, closures, balances] = await Promise.all([
    readFile(path.join(dataDir, name, "requests.csv"), "utf8").then(parseRequests),
    readFile(path.join(dataDir, "closures.csv"), "utf8").then(parseClosures),
    readFile(path.join(dataDir, "balances.csv"), "utf8").then(parseBalances),
  ]);
  return { name, requests, checks: checkRequests(requests, closures, balances) };
}

const BOUNDARY = /<\/?\s*review_data\b[^>]*>?/gi;

/** Прибирає з тексту людини теги межі, щоб коментар не міг «закрити» блок даних. */
export function sanitizeComment(text: string): string {
  return text.replace(BOUNDARY, "");
}

/**
 * Відповідь інструмента: заявки (коментарі — ДАНІ людей) і перевірки (їх порахував код — довіряй їм).
 * Усе загорнуте в <review_data>, щоб модель бачила межу.
 */
export function reviewPayload(set: ReviewSet) {
  const checks = new Map(set.checks.map((c) => [c.id, c]));
  const requests = set.requests.map((r) => ({
    id: r.id,
    employee: r.employee,
    type: r.type,
    starts_on: r.startsOn,
    ends_on: r.endsOn,
    days: checks.get(r.id)?.days ?? 0,
    comment: sanitizeComment(r.comment),
  }));
  const computed = set.checks.map((c) => ({ id: c.id, flags: c.flags, details: c.details }));
  return `<review_data set="${set.name}" count="${set.requests.length}">\n${JSON.stringify({ requests, computed_checks: computed }, null, 2)}\n</review_data>`;
}

export async function reviewToolResult(dataDir: string, name: string) {
  try {
    return { content: [{ type: "text" as const, text: reviewPayload(await loadSet(dataDir, name)) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Не вдалося прочитати набір: ${(e as Error).message}` }], isError: true };
  }
}
