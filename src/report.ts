// Формат результату працівника і «перевіряльник у коді».
// Модель повертає JSON за схемою (outputFormat), а код ще раз перевіряє його zod і звіряє з тим, що порахував сам.
import { z } from "zod";
import { FLAGS, type Check } from "./checks.ts";
import { checkWritePath } from "./guard.ts";

export const ReviewItem = z.object({
  id: z.string().describe("id заявки, напр. REQ-01"),
  recommendation: z.enum(["ready_for_decision", "needs_attention"]),
  flags: z.array(z.enum(FLAGS)).describe("рівно ті прапорці, що в computed_checks для цієї заявки"),
  note: z.string().min(1).describe("одне речення для менеджера простими словами"),
});

export const ReviewReport = z.object({
  status: z.enum(["ok", "needs_attention"]),
  items: z.array(ReviewItem),
  report_file: z.string().describe("шлях до markdown-звіту, який записав працівник, напр. out/2026-11-17-review-clean.md"),
  summary: z.string().describe("2–3 речення для менеджера"),
});

export type ReviewReport = z.infer<typeof ReviewReport>;

/** JSON Schema для options.outputFormat — з тієї самої zod-схеми, щоб формат був в одному місці. */
export function reviewJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReviewReport) as Record<string, unknown>;
}

export type Verdict = { ok: true; report: ReviewReport } | { ok: false; problems: string[] };

/**
 * Перевіряльник у коді (детермінований): схема; кожна заявка рівно один раз; без вигаданих id;
 * прапорці збігаються з порахованими кодом (модель не може ні зняти, ні вигадати проблему);
 * рекомендація needs_attention рівно тоді, коли є прапорці; status збігається з підсумком; шлях звіту — всередині out/.
 * Чи файл справді існує і чи містить усі id, перевіряє worker.ts після запуску.
 */
export function verifyReview(raw: unknown, expected: Check[], cwd: string, outDir = "out"): Verdict {
  const parsed = ReviewReport.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `схема: ${i.path.join(".") || "(корінь)"} — ${i.message}`) };
  }
  const report = parsed.data;
  const problems: string[] = [];
  const byId = new Map(expected.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const item of report.items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const id of byId.keys()) if (!counts.has(id)) problems.push(`заявку ${id} пропущено`);
  for (const [id, n] of counts) {
    if (!byId.has(id)) problems.push(`заявки ${id} немає у вхідних — вигаданий id`);
    else if (n > 1) problems.push(`заявку ${id} розібрано ${n} рази`);
  }
  for (const item of report.items) {
    const check = byId.get(item.id);
    if (!check) continue;
    const got = [...new Set(item.flags)].sort().join(",");
    const want = [...check.flags].sort().join(",");
    if (got !== want || item.flags.length !== new Set(item.flags).size) {
      problems.push(`${item.id}: прапорці «${got || "—"}» не збігаються з порахованими кодом «${want || "—"}»`);
    }
    const shouldAttend = check.flags.length > 0;
    if (shouldAttend && item.recommendation !== "needs_attention") problems.push(`${item.id}: є прапорці, а рекомендація ${item.recommendation}`);
    if (!shouldAttend && item.recommendation !== "ready_for_decision") problems.push(`${item.id}: прапорців немає, а рекомендація ${item.recommendation}`);
  }
  const anyAttention = expected.some((c) => c.flags.length > 0);
  if (anyAttention && report.status === "ok") problems.push("є заявки з прапорцями, а status = ok (має бути needs_attention)");
  if (!anyAttention && report.status === "needs_attention") problems.push("прапорців немає, а status = needs_attention (має бути ok)");
  const where = checkWritePath(report.report_file, cwd, outDir);
  if (!where.ok) problems.push(`звіт: ${where.reason}`);
  return problems.length ? { ok: false, problems } : { ok: true, report };
}
