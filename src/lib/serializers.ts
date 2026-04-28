import type { Expense, SplitShare } from "@prisma/client";
import { paiseToDecimal } from "./money";

export type ExpenseWithShares = Expense & {
  splitShares: SplitShare[];
};

export function serializeSplitShare(share: SplitShare) {
  return {
    id: share.id,
    friendName: share.friendName,
    amount: paiseToDecimal(share.amountPaise),
    amountPaise: share.amountPaise,
    settledAt: share.settledAt ? share.settledAt.toISOString() : null
  };
}

export function serializeExpense(expense: ExpenseWithShares) {
  return {
    id: expense.id,
    amount: paiseToDecimal(expense.amountPaise),
    amountPaise: expense.amountPaise,
    category: expense.category,
    description: expense.description,
    date: expense.date.toISOString().slice(0, 10),
    created_at: expense.createdAt.toISOString(),
    splitShares: expense.splitShares.map(serializeSplitShare)
  };
}
