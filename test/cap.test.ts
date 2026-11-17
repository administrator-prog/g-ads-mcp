import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWithinCap } from "../src/google-ads/write.js";

// Kaarsberg-like: 12 old PAUSED campaigns with big budgets, plus the two new paused Plan 2 campaigns.
const rows = [
  ...[100, 11.5, 50, 100, 17, 50, 5, 3, 3, 3, 3, 3].map((b, i) => ({ id: 100 + i, status: "PAUSED", b })),
  { id: 1, status: "PAUSED", b: 7 },
  { id: 2, status: "PAUSED", b: 6 },
];
function stub(over: Record<number, string> = {}) {
  return {
    query: async () =>
      rows.map((r) => ({
        campaign: { id: r.id, name: `c${r.id}`, status: over[r.id] ?? r.status },
        campaign_budget: { resource_name: `customers/9375048103/campaignBudgets/${r.id}`, amount_micros: r.b * 1e6 },
        customer: { currency_code: "EUR" },
      })),
  } as never;
}
const t = { customerId: "9375048103", monthlyCap: 400 };

test("old paused campaigns do not count; enabling both Plan 2 campaigns fits (13/day = 395.2)", async () => {
  const r = await assertWithinCap(stub(), t, { enable: ["1", "2"] });
  assert.equal(r.projectedMonthly, 395.2);
});
test("enabling an old 100/day campaign is refused", async () => {
  await assert.rejects(assertWithinCap(stub(), t, { enable: ["100"] }), /over the 400 cap/);
});
test("raising an enabled campaign's budget past the cap is refused", async () => {
  await assert.rejects(assertWithinCap(stub({ 1: "ENABLED", 2: "ENABLED" }), t, { budgets: { "1": 7.5 } }), /395|over the 400 cap/);
});
test("raising within the cap is allowed", async () => {
  const r = await assertWithinCap(stub({ 1: "ENABLED", 2: "ENABLED" }), t, { budgets: { "1": 7.1 } });
  assert.ok(r.projectedMonthly <= 400);
});
test("enabling a third campaign on top of the two is refused", async () => {
  await assert.rejects(assertWithinCap(stub({ 1: "ENABLED", 2: "ENABLED" }), t, { enable: ["107"] }), /over the 400 cap/);
});
