import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findMany: vi.fn()
}));

vi.mock("./db", () => ({
  prisma: {
    expense: {
      findMany: db.findMany
    }
  }
}));

import { listExpenses } from "./expenses-service";

function expense(overrides: {
  amountPaise: number;
  category: string;
  date?: string;
  description?: string;
  id?: string;
}) {
  return {
    id: overrides.id ?? `expense-${overrides.category}-${overrides.amountPaise}`,
    amountPaise: overrides.amountPaise,
    category: overrides.category,
    description: overrides.description ?? `${overrides.category} spend`,
    date: new Date(`${overrides.date ?? "2026-04-29"}T00:00:00.000Z`),
    createdAt: new Date("2026-04-29T10:00:00.000Z"),
    clientRequestId: null,
    requestHash: null,
    splitShares: []
  };
}

describe("expenses service list", () => {
  beforeEach(() => {
    db.findMany.mockReset();
  });

  it("filters by category through the API query and totals only returned visible rows", async () => {
    db.findMany.mockResolvedValue([
      expense({ amountPaise: 12_050, category: "Dining", description: "Biryani" }),
      expense({ amountPaise: 6_000, category: "Dining", description: "Coffee" })
    ]);

    const result = await listExpenses(new URLSearchParams("category=Dining&sort=date_desc"));
    const body = result.body as { expenses: unknown[]; total: string; totalPaise: number };

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { category: "Dining" },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }]
      })
    );
    expect(body.expenses).toHaveLength(2);
    expect(body.totalPaise).toBe(18_050);
    expect(body.total).toBe("180.50");
  });

  it("uses requested sort order without changing the visible total", async () => {
    db.findMany.mockResolvedValue([
      expense({ amountPaise: 50_000, category: "Groceries" }),
      expense({ amountPaise: 10_000, category: "Dining" })
    ]);

    const result = await listExpenses(new URLSearchParams("sort=amount_desc"));
    const body = result.body as { totalPaise: number };

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: undefined,
        orderBy: [{ amountPaise: "desc" }, { date: "desc" }]
      })
    );
    expect(body.totalPaise).toBe(60_000);
  });

  it("can sort by newest saved expense first", async () => {
    db.findMany.mockResolvedValue([
      expense({ amountPaise: 10_000, category: "Food" }),
      expense({ amountPaise: 5_000, category: "Rent" })
    ]);

    await listExpenses(new URLSearchParams("sort=created_desc"));

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: undefined,
        orderBy: [{ createdAt: "desc" }, { date: "desc" }]
      })
    );
  });

  it("filters by an inclusive expense date range", async () => {
    db.findMany.mockResolvedValue([
      expense({ amountPaise: 12_000, category: "Food", date: "2026-04-15" })
    ]);

    await listExpenses(new URLSearchParams("date_from=2026-04-01&date_to=2026-04-30"));

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          date: {
            gte: new Date("2026-04-01T00:00:00.000Z"),
            lte: new Date("2026-04-30T00:00:00.000Z")
          }
        }
      })
    );
  });
});
