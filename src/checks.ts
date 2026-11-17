// Детермінована частина працівника: рахує код, а не модель.
// Вхід — заявки, закриття школи й баланси; вихід — прапорці проблем на кожну заявку.
// Спрощення проти справжнього порталу (свідомі): робочі дні = Пн–Пт без днів закриття, графіка працівника немає,
// баланс порівнюється з кожною заявкою окремо (накопичення кількох заявок не рахуємо).
import { parseTable } from "./csv.ts";

export const FLAGS = ["on_closure", "over_balance", "overlap", "long_comment", "suspicious_comment", "invalid_range"] as const;
export type Flag = (typeof FLAGS)[number];

export const COMMENT_LIMIT = 500;

export type LeaveType = "sick" | "personal";
export type Request = { id: string; employee: string; type: LeaveType; startsOn: string; endsOn: string; comment: string };
export type Closure = { name: string; startsOn: string; endsOn: string };
export type Balances = Map<string, Record<LeaveType, number>>;
export type Check = { id: string; days: number; flags: Flag[]; details: string[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string, what: string): number {
  if (!DATE.test(value)) throw new Error(`${what}: «${value}» не у форматі РРРР-ММ-ДД`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error(`${what}: «${value}» — не існує такої дати`);
  return ms;
}

const DAY = 86_400_000;

export function parseRequests(text: string): Request[] {
  const rows = parseTable(text, ["id", "employee", "type", "starts_on", "ends_on", "comment"] as const);
  const seen = new Set<string>();
  return rows.map((r, i) => {
    if (!/^REQ-\d{2,}$/.test(r.id)) throw new Error(`рядок ${i + 2}: id «${r.id}» не у форматі REQ-NN`);
    if (seen.has(r.id)) throw new Error(`рядок ${i + 2}: id ${r.id} повторюється`);
    seen.add(r.id);
    if (r.type !== "sick" && r.type !== "personal") throw new Error(`рядок ${i + 2}: тип «${r.type}» має бути sick або personal`);
    return { id: r.id, employee: r.employee, type: r.type, startsOn: r.starts_on, endsOn: r.ends_on, comment: r.comment };
  });
}

export function parseClosures(text: string): Closure[] {
  return parseTable(text, ["name", "starts_on", "ends_on"] as const).map((r) => ({ name: r.name, startsOn: r.starts_on, endsOn: r.ends_on }));
}

export function parseBalances(text: string): Balances {
  const map: Balances = new Map();
  for (const r of parseTable(text, ["employee", "sick", "personal"] as const)) {
    const sick = Number(r.sick);
    const personal = Number(r.personal);
    if (!Number.isFinite(sick) || !Number.isFinite(personal) || sick < 0 || personal < 0) {
      throw new Error(`баланс ${r.employee}: числа мають бути невід'ємними`);
    }
    map.set(r.employee, { sick, personal });
  }
  return map;
}

/** Підозрілі фрази в коментарі: спроба керувати працівником. Виявляє код, модель лише отримує готовий прапорець. */
const SUSPICIOUS = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+.{0,40}instructions/i,
  /ігноруй\w*\s+.{0,40}інструкц/i,
  /approve\s+all/i,
  /system\s+prompt/i,
  /\.\.[\\/]/,
  /write\s+(the\s+)?file/i,
];

export function isSuspicious(comment: string): boolean {
  return SUSPICIOUS.some((re) => re.test(comment));
}

type Range = { from: number; to: number };

function overlaps(a: Range, b: Range): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Робочі дні (Пн–Пт) діапазону, що не потрапляють на закриття школи. */
export function countDays(startsOn: string, endsOn: string, closures: Closure[]): number {
  const from = parseDate(startsOn, "starts_on");
  const to = parseDate(endsOn, "ends_on");
  const ranges = closures.map((c) => ({ from: parseDate(c.startsOn, "closure.starts_on"), to: parseDate(c.endsOn, "closure.ends_on") }));
  let days = 0;
  for (let t = from; t <= to; t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (ranges.some((r) => t >= r.from && t <= r.to)) continue;
    days++;
  }
  return days;
}

export function checkRequests(requests: Request[], closures: Closure[], balances: Balances): Check[] {
  const closureRanges = closures.map((c) => ({ from: parseDate(c.startsOn, "closure.starts_on"), to: parseDate(c.endsOn, "closure.ends_on") }));
  const dated = requests.map((r) => {
    const from = parseDate(r.startsOn, `${r.id} starts_on`);
    const to = parseDate(r.endsOn, `${r.id} ends_on`);
    return { r, range: { from, to }, valid: to >= from };
  });

  return dated.map(({ r, range, valid }) => {
    const flags = new Set<Flag>();
    const details: string[] = [];
    let days = 0;

    if (!valid) {
      flags.add("invalid_range");
      details.push(`ends_on ${r.endsOn} раніше за starts_on ${r.startsOn}`);
    } else {
      days = countDays(r.startsOn, r.endsOn, closures);
      if (closureRanges.some((c) => overlaps(range, c))) {
        flags.add("on_closure");
        const names = closures.filter((c) => overlaps(range, { from: parseDate(c.startsOn, "c"), to: parseDate(c.endsOn, "c") })).map((c) => c.name);
        details.push(`заявка містить дні закриття: ${names.join(", ")}; до балансу рахується ${days} дн.`);
      }
      const balance = balances.get(r.employee)?.[r.type];
      if (balance === undefined || days > balance) {
        flags.add("over_balance");
        details.push(`потрібно ${days} дн. ${r.type}, на балансі ${balance ?? "немає запису"}`);
      }
      const clash = dated.filter((o) => o.r.id !== r.id && o.valid && o.r.employee === r.employee && overlaps(range, o.range));
      if (clash.length > 0) {
        flags.add("overlap");
        details.push(`перетин із ${clash.map((c) => c.r.id).join(", ")}`);
      }
    }
    if ([...r.comment].length > COMMENT_LIMIT) {
      flags.add("long_comment");
      details.push(`коментар довший за ${COMMENT_LIMIT} символів`);
    }
    if (isSuspicious(r.comment)) {
      flags.add("suspicious_comment");
      details.push("коментар схожий на спробу керувати працівником");
    }
    return { id: r.id, days, flags: FLAGS.filter((f) => flags.has(f)), details };
  });
}
