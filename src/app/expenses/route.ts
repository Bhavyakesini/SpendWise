import { handleExpensesGet, handleExpensesPost } from "@/lib/route-handlers";

export const runtime = "nodejs";
export const GET = handleExpensesGet;
export const POST = handleExpensesPost;
