import { handleExpenseDelete, handleExpensePatch } from "@/lib/route-handlers";

export const runtime = "nodejs";
export const PATCH = handleExpensePatch;
export const DELETE = handleExpenseDelete;
