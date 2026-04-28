import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { buildAnomalyAlert, buildSplitShares, hashExpenseRequest, parseExpenseDate } from "./expense-logic";
import { paiseToDecimal } from "./money";
import { createExpenseSchema, expensesQuerySchema, updateExpenseSchema } from "./schemas";
import { serializeExpense } from "./serializers";

type ServiceResult = {
  status: number;
  body: unknown;
};

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

function validationError(error: unknown): ServiceResult {
  return {
    status: 400,
    body: {
      error: "Validation failed.",
      details: error
    }
  };
}

export async function listExpenses(searchParams: URLSearchParams): Promise<ServiceResult> {
  const parsed = expensesQuerySchema.safeParse({
    category: searchParams.get("category") || undefined,
    sort: searchParams.get("sort") || undefined
  });

  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const expenses = await prisma.expense.findMany({
    where: parsed.data.category ? { category: parsed.data.category } : undefined,
    orderBy: buildOrderBy(parsed.data.sort),
    include: {
      splitShares: {
        orderBy: [{ settledAt: "asc" }, { friendName: "asc" }]
      }
    }
  });

  const totalPaise = expenses.reduce((sum, expense) => sum + expense.amountPaise, 0);

  return {
    status: 200,
    body: {
      expenses: expenses.map(serializeExpense),
      total: paiseToDecimal(totalPaise),
      totalPaise
    }
  };
}

function buildOrderBy(sort: "created_desc" | "date_desc" | "date_asc" | "amount_desc" | undefined) {
  if (sort === "created_desc") {
    return [{ createdAt: "desc" as const }, { date: "desc" as const }];
  }

  if (sort === "date_asc") {
    return [{ date: "asc" as const }, { createdAt: "asc" as const }];
  }

  if (sort === "amount_desc") {
    return [{ amountPaise: "desc" as const }, { date: "desc" as const }];
  }

  return [{ date: "desc" as const }, { createdAt: "desc" as const }];
}

export async function createExpense(payload: unknown, idempotencyHeader: string | null): Promise<ServiceResult> {
  const parsed = createExpenseSchema.safeParse(payload);

  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const input = parsed.data;
  const clientRequestId = (idempotencyHeader || input.clientRequestId || "").trim() || null;

  if (clientRequestId && !IDEMPOTENCY_KEY_PATTERN.test(clientRequestId)) {
    return {
      status: 400,
      body: {
        error: "Invalid idempotency key."
      }
    };
  }

  const splitShares = buildSplitShares(
    input.split?.mode === "exact"
      ? {
          mode: "exact",
          shares: input.split.shares.map((share) => ({
            friendName: share.friendName,
            amountPaise: share.amount
          }))
        }
      : input.split,
    input.amount
  );

  const requestShape = {
    amountPaise: input.amount,
    category: input.category,
    description: input.description,
    date: input.date,
    splitShares
  };
  const requestHash = hashExpenseRequest(requestShape);

  if (clientRequestId) {
    const existing = await prisma.expense.findUnique({
      where: { clientRequestId },
      include: { splitShares: { orderBy: { friendName: "asc" } } }
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return {
          status: 409,
          body: {
            error: "This submission key was already used for a different expense."
          }
        };
      }

      return {
        status: 200,
        body: {
          expense: serializeExpense(existing),
          idempotent: true,
          alert: null
        }
      };
    }
  }

  const categoryStats = await prisma.expense.aggregate({
    where: { category: input.category },
    _avg: { amountPaise: true },
    _count: { _all: true }
  });

  const alert = buildAnomalyAlert({
    amountPaise: input.amount,
    averagePaise: categoryStats._avg.amountPaise,
    expenseCount: categoryStats._count._all,
    category: input.category
  });

  try {
    const expense = await prisma.expense.create({
      data: {
        amountPaise: input.amount,
        category: input.category,
        description: input.description,
        date: parseExpenseDate(input.date),
        clientRequestId,
        requestHash,
        splitShares: {
          create: splitShares
        }
      },
      include: {
        splitShares: {
          orderBy: { friendName: "asc" }
        }
      }
    });

    return {
      status: 201,
      body: {
        expense: serializeExpense(expense),
        idempotent: false,
        alert
      }
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && clientRequestId) {
      const existing = await prisma.expense.findUnique({
        where: { clientRequestId },
        include: { splitShares: { orderBy: { friendName: "asc" } } }
      });

      if (existing && existing.requestHash === requestHash) {
        return {
          status: 200,
          body: {
            expense: serializeExpense(existing),
            idempotent: true,
            alert: null
          }
        };
      }
    }

    throw error;
  }
}

export async function updateExpense(id: string, payload: unknown): Promise<ServiceResult> {
  const parsed = updateExpenseSchema.safeParse(payload);

  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const existing = await prisma.expense.findUnique({
    where: { id }
  });

  if (!existing) {
    return {
      status: 404,
      body: {
        error: "Expense not found."
      }
    };
  }

  const input = parsed.data;
  const splitShares = buildSplitShares(
    input.split?.mode === "exact"
      ? {
          mode: "exact",
          shares: input.split.shares.map((share) => ({
            friendName: share.friendName,
            amountPaise: share.amount
          }))
        }
      : input.split,
    input.amount
  );
  const requestHash = hashExpenseRequest({
    amountPaise: input.amount,
    category: input.category,
    description: input.description,
    date: input.date,
    splitShares
  });

  const expense = await prisma.$transaction(async (tx) => {
    await tx.splitShare.deleteMany({
      where: { expenseId: id }
    });

    return tx.expense.update({
      where: { id },
      data: {
        amountPaise: input.amount,
        category: input.category,
        description: input.description,
        date: parseExpenseDate(input.date),
        requestHash,
        splitShares: {
          create: splitShares
        }
      },
      include: {
        splitShares: {
          orderBy: { friendName: "asc" }
        }
      }
    });
  });

  return {
    status: 200,
    body: {
      expense: serializeExpense(expense)
    }
  };
}

export async function deleteExpense(id: string): Promise<ServiceResult> {
  try {
    await prisma.expense.delete({
      where: { id }
    });

    return {
      status: 200,
      body: {
        deleted: true
      }
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return {
        status: 404,
        body: {
          error: "Expense not found."
        }
      };
    }

    throw error;
  }
}
