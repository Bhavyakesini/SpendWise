import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);

    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prisma = new PrismaClient();

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "Expense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "amountPaise" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "date" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clientRequestId" TEXT,
  "requestHash" TEXT
);
`);

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "SplitShare" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expenseId" TEXT NOT NULL,
  "friendName" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "settledAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SplitShare_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`);

await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Expense_clientRequestId_key" ON "Expense"("clientRequestId");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Expense_category_idx" ON "Expense"("category");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Expense_date_idx" ON "Expense"("date");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SplitShare_friendName_idx" ON "SplitShare"("friendName");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SplitShare_settledAt_idx" ON "SplitShare"("settledAt");`);

await prisma.$disconnect();

console.log("SQLite database is ready.");
