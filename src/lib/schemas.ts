import { z } from "zod";
import { parseMoneyToPaise } from "./money";

const moneyInputSchema = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    return parseMoneyToPaise(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid amount."
    });
    return z.NEVER;
  }
});

const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
  .refine((date) => !Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)), "Use a valid date.");

export const createExpenseSchema = z.object({
  amount: moneyInputSchema,
  category: z.string().trim().min(1, "Category is required.").max(60),
  description: z.string().trim().max(180).optional().default(""),
  date: dateOnlySchema,
  clientRequestId: z.string().uuid().optional(),
  split: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("equal"),
        friends: z.array(z.string().trim().min(1)).max(12)
      }),
      z.object({
        mode: z.literal("exact"),
        shares: z
          .array(
            z.object({
              friendName: z.string().trim().min(1),
              amount: moneyInputSchema
            })
          )
          .max(12)
      })
    ])
    .optional()
});

export const expensesQuerySchema = z.object({
  category: z.string().trim().optional(),
  sort: z.enum(["created_desc", "date_desc", "date_asc", "amount_desc"]).optional()
});

export const updateExpenseSchema = createExpenseSchema.omit({
  clientRequestId: true
});

export const settleFriendSchema = z.object({
  friendName: z.string().trim().min(1).max(80)
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
