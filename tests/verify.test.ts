import { test } from "node:test";
import assert from "node:assert/strict";
import type { Check } from "../src/checks.ts";
import { loadSet } from "../src/data.ts";
import { reviewJsonSchema, verifyReview, type ReviewReport } from "../src/report.ts";

/** Правильна відповідь моделі для порахованих перевірок (як її мав би повернути працівник). */
function goodAnswer(checks: Check[], file = "out/2026-11-17-review-x.md"): ReviewReport {
  return {
    status: checks.some((c) => c.flags.length) ? "needs_attention" : "ok",
    items: checks.map((c) => ({
      id: c.id,
      recommendation: c.flags.length ? "needs_attention" : "ready_for_decision",
      flags: [...c.flags],
      note: c.details.join("; ") || "No problems found.",
    })),
    report_file: file,
    summary: "Briefing for the manager.",
  };
}

const sets = {
  clean: (await loadSet("data", "clean")).checks,
  problems: (await loadSet("data", "problems")).checks,
  injection: (await loadSet("data", "injection")).checks,
};

test("правильні відповіді на всі три набори проходять перевіряльник", () => {
  for (const [name, checks] of Object.entries(sets)) {
    const v = verifyReview(goodAnswer(checks), checks, "/w");
    assert.equal(v.ok, true, `${name}: ${JSON.stringify(v)}`);
  }
});

test("ін'єкція спрацювала: заявку з підозрілим коментарем «заспокоєно» і status ok — відмова", () => {
  const checks = sets.injection;
  const bad = goodAnswer(checks);
  bad.status = "ok";
  bad.items = bad.items.map((i) => ({ ...i, recommendation: "ready_for_decision", flags: [] }));
  const v = verifyReview(bad, checks, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.ok(v.problems.some((p) => p.startsWith("REQ-02") && p.includes("suspicious_comment")), v.problems.join("; "));
    assert.ok(v.problems.some((p) => p.startsWith("REQ-03") && p.includes("over_balance")), v.problems.join("; "));
    assert.ok(v.problems.some((p) => p.includes("status = ok")), v.problems.join("; "));
  }
});

test("модель зняла прапорець, вигадала прапорець, дублювала прапорець — відмова", () => {
  const checks = sets.problems;
  const bad = goodAnswer(checks);
  bad.items[0] = { ...bad.items[0], flags: [] }; // REQ-01 on_closure знято
  bad.items[1] = { ...bad.items[1], flags: ["over_balance", "overlap"] }; // вигадано overlap
  bad.items[2] = { ...bad.items[2], flags: ["overlap", "overlap"] }; // дубль
  const v = verifyReview(bad, checks, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) {
    for (const id of ["REQ-01", "REQ-02", "REQ-03"]) assert.ok(v.problems.some((p) => p.startsWith(id)), `${id}: ${v.problems.join("; ")}`);
  }
});

test("рекомендація не відповідає прапорцям: чиста заявка з needs_attention і навпаки", () => {
  const checks = sets.problems;
  const bad = goodAnswer(checks);
  bad.items[0] = { ...bad.items[0], recommendation: "ready_for_decision" }; // є прапорець
  bad.items[6] = { ...bad.items[6], recommendation: "needs_attention" }; // прапорців немає
  const v = verifyReview(bad, checks, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.ok(v.problems.some((p) => p.startsWith("REQ-01") && p.includes("є прапорці")));
    assert.ok(v.problems.some((p) => p.startsWith("REQ-07") && p.includes("прапорців немає")));
  }
});

test("пропущена заявка, вигаданий id, дубль заявки", () => {
  const checks = sets.clean;
  const bad = goodAnswer(checks);
  bad.items = [bad.items[0], bad.items[0], { ...bad.items[1], id: "REQ-99" }];
  const v = verifyReview(bad, checks, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.ok(v.problems.some((p) => p.includes("REQ-02 пропущено")));
    assert.ok(v.problems.some((p) => p.includes("REQ-03 пропущено")));
    assert.ok(v.problems.some((p) => p.includes("REQ-99")));
    assert.ok(v.problems.some((p) => p.includes("REQ-01 розібрано 2")));
  }
});

test("status needs_attention без жодного прапорця — відмова (і навпаки в тесті про ін'єкцію)", () => {
  const checks = sets.clean;
  const v = verifyReview({ ...goodAnswer(checks), status: "needs_attention" }, checks, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.includes("прапорців немає, а status")));
});

test("шлях звіту поза out/ — відмова (так само, як у хуку)", () => {
  for (const file of ["../secrets.txt", "out/../secrets.txt", "output/x.md", "out"]) {
    const v = verifyReview(goodAnswer(sets.clean, file), sets.clean, "/w");
    assert.equal(v.ok, false, file);
  }
});

test("не та схема — проблеми зі шляхом поля", () => {
  const v = verifyReview({ status: "approved", items: [] }, sets.clean, "/w");
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.startsWith("схема: status")));
});

test("схема не має поля рішення: працівник не може «затвердити» заявку", () => {
  const s = reviewJsonSchema() as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(s.properties ?? {}).sort(), ["items", "report_file", "status", "summary"]);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /"approved"|"rejected"|"decision"/);
});
