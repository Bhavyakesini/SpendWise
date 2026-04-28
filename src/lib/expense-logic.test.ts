import { describe, expect, it } from "vitest";
import { buildAnomalyAlert, buildSplitShares } from "./expense-logic";

describe("expense logic", () => {
  it("splits expenses equally between the payer and friends", () => {
    expect(buildSplitShares({ mode: "equal", friends: ["Asha", "Ben"] }, 9000)).toEqual([
      { friendName: "Asha", amountPaise: 3000 },
      { friendName: "Ben", amountPaise: 3000 }
    ]);
  });

  it("prevents exact split shares exceeding the expense amount", () => {
    expect(() =>
      buildSplitShares(
        {
          mode: "exact",
          shares: [{ friendName: "Asha", amountPaise: 10_000 }]
        },
        5_000
      )
    ).toThrow();
  });

  it("flags category spikes only after a small history exists", () => {
    expect(
      buildAnomalyAlert({
        amountPaise: 9_000,
        averagePaise: 2_000,
        expenseCount: 3,
        category: "Dining"
      })
    ).toMatchObject({ kind: "category_spike" });

    expect(
      buildAnomalyAlert({
        amountPaise: 9_000,
        averagePaise: 2_000,
        expenseCount: 2,
        category: "Dining"
      })
    ).toBeNull();
  });
});
