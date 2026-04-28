import { NextResponse } from "next/server";
import { createExpense, deleteExpense, listExpenses, updateExpense } from "./expenses-service";
import { listSettlements, settleFriend } from "./settlements-service";

export const runtime = "nodejs";

export async function handleExpensesGet(request: Request) {
  const result = await listExpenses(new URL(request.url).searchParams);
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleExpensesPost(request: Request) {
  const payload = await request.json().catch(() => null);
  const result = await createExpense(payload, request.headers.get("x-idempotency-key"));
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleExpensePatch(request: Request, context: { params: Promise<{ id: string }> }) {
  const payload = await request.json().catch(() => null);
  const { id } = await context.params;
  const result = await updateExpense(id, payload);
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleExpenseDelete(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await deleteExpense(id);
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleSettlementsGet() {
  const result = await listSettlements();
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleSettleFriendPost(request: Request) {
  const payload = await request.json().catch(() => null);
  const result = await settleFriend(payload);
  return NextResponse.json(result.body, { status: result.status });
}
