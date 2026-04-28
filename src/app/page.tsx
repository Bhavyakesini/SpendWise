"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  CheckCircle2,
  Download,
  Edit3,
  Filter,
  IndianRupee,
  Loader2,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Split,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast, Toaster } from "sonner";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";

type SplitShare = {
  id: string;
  friendName: string;
  amount: string;
  amountPaise: number;
  settledAt: string | null;
};

type Expense = {
  id: string;
  amount: string;
  amountPaise: number;
  category: string;
  description: string;
  date: string;
  created_at: string;
  splitShares: SplitShare[];
};

type ExpensesResponse = {
  expenses: Expense[];
  total: string;
  totalPaise: number;
};

type Settlement = {
  friendName: string;
  owesUser: string;
  owesUserPaise: number;
  expenseCount: number;
};

type SortKey = "date_desc" | "date_asc" | "amount_desc";

type ExpensePayload = ExpenseFormValues & {
  clientRequestId: string;
  split?:
    | {
        mode: "equal";
        friends: string[];
      }
    | {
        mode: "exact";
        shares: Array<{
          friendName: string;
          amount: string;
        }>;
      };
};

type CreateExpenseResponse = {
  expense: Expense;
  idempotent: boolean;
  alert: { message: string } | null;
};

type PendingExpense = {
  id: string;
  payload: ExpensePayload;
  createdAt: string;
  lastError?: string;
};

const DEFAULT_CATEGORIES = [
  "Groceries",
  "Dining",
  "Transport",
  "Bills",
  "Health",
  "Entertainment",
  "Shopping",
  "Rent",
  "Utilities",
  "Travel",
  "Education",
  "Miscellaneous"
];
const DRAFT_KEY = "expense-tracker-draft-id";
const OFFLINE_QUEUE_KEY = "expense-tracker-offline-queue";
const REVIEW_LIMIT_PAISE = 50_000;

const expenseFormSchema = z.object({
  amount: z.string().refine((value) => amountToPaise(value) !== null, "Enter a positive amount."),
  category: z.string().trim().min(1, "Choose a category."),
  description: z.string().trim().min(1, "Add a description.").max(180, "Keep it under 180 characters."),
  date: z
    .string()
    .trim()
    .min(1, "Choose a date.")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
});

type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function defaultFormValues(category = "Groceries"): ExpenseFormValues {
  return {
    amount: "",
    category,
    description: "",
    date: today()
  };
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatInr(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(paise / 100);
}

function formatAmountInput(value: string) {
  const paise = amountToPaise(value);

  if (!paise) {
    return value.trim();
  }

  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(paise / 100);
}

function sanitizeAmount(value: string) {
  const stripped = value.replace(/[^\d.]/g, "");
  const firstDot = stripped.indexOf(".");

  if (firstDot === -1) {
    return stripped;
  }

  return `${stripped.slice(0, firstDot + 1)}${stripped.slice(firstDot + 1).replace(/\./g, "")}`;
}

function amountToPaise(value: string) {
  const normalized = value.trim().replace(/[₹,\s]/g, "");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [rupees, paise = ""] = normalized.split(".");
  const total = Number(BigInt(rupees) * 100n + BigInt(paise.padEnd(2, "0")));
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

async function readJsonError(response: Response) {
  const payload = await response.json().catch(() => null);
  return payload?.error || "Something went wrong.";
}

async function fetchExpenses(category: string, sort: SortKey): Promise<ExpensesResponse> {
  const params = new URLSearchParams();

  if (category) {
    params.set("category", category);
  }

  params.set("sort", sort);

  const response = await fetch(`/expenses?${params.toString()}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await readJsonError(response));
  }

  return response.json();
}

async function fetchSettlements(): Promise<{ settlements: Settlement[] }> {
  const response = await fetch("/api/settlements", {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await readJsonError(response));
  }

  return response.json();
}

class ExpenseSubmitError extends Error {
  constructor(
    message: string,
    readonly queueable: boolean
  ) {
    super(message);
  }
}

async function postExpensePayload(payload: ExpensePayload): Promise<CreateExpenseResponse> {
  let response: Response;

  try {
    response = await fetch("/expenses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": payload.clientRequestId
      },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new ExpenseSubmitError("Network unavailable. Saved to offline queue.", true);
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ExpenseSubmitError(body?.error || "Could not save the expense.", response.status >= 500);
  }

  return body as CreateExpenseResponse;
}

async function updateExpensePayload(id: string, payload: ExpensePayload) {
  const response = await fetch(`/expenses/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await readJsonError(response));
  }

  return response.json();
}

async function deleteExpenseRequest(id: string) {
  const response = await fetch(`/expenses/${id}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error(await readJsonError(response));
  }

  return response.json();
}

function readPendingQueue(): PendingExpense[] {
  try {
    const rawQueue = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
    return rawQueue ? (JSON.parse(rawQueue) as PendingExpense[]) : [];
  } catch {
    return [];
  }
}

function writePendingQueue(queue: PendingExpense[]) {
  window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function uniqueNames(input: string) {
  return Array.from(
    new Map(
      input
        .split(",")
        .map((name) => name.trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .map((name) => [name.toLocaleLowerCase("en-IN"), name])
    ).values()
  );
}

function exportCsv(expenses: Expense[]) {
  const excelText = (value: string) => `="${value.replace(/"/g, '""')}"`;
  const rows = [
    ["Date", "Category", "Description", "Amount", "Split"],
    ...expenses.map((expense) => [
      excelText(expense.date),
      expense.category,
      expense.description,
      expense.amount,
      expense.splitShares.map((share) => `${share.friendName}: ${share.amount}`).join("; ")
    ])
  ];
  const csv = rows
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "expenses.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const submitLockRef = useRef(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [clientRequestId, setClientRequestId] = useState("");
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitMode, setSplitMode] = useState<"equal" | "exact">("equal");
  const [splitNames, setSplitNames] = useState("");
  const [exactShares, setExactShares] = useState<Record<string, string>>({});
  const [pendingQueue, setPendingQueue] = useState<PendingExpense[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncingQueue, setIsSyncingQueue] = useState(false);
  const [isExpenseDialogOpen, setIsExpenseDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [isSubmitLocked, setIsSubmitLocked] = useState(false);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseFormSchema),
    defaultValues: defaultFormValues(),
    mode: "onBlur"
  });
  const { control, formState, handleSubmit, register, reset, setValue, getValues } = form;

  const expensesQuery = useQuery({
    queryKey: ["expenses", categoryFilter, sort],
    queryFn: () => fetchExpenses(categoryFilter, sort)
  });

  const allExpensesQuery = useQuery({
    queryKey: ["expenses", "all-categories"],
    queryFn: () => fetchExpenses("", "date_desc")
  });

  const settlementsQuery = useQuery({
    queryKey: ["settlements"],
    queryFn: fetchSettlements
  });

  const visibleExpenses = expensesQuery.data?.expenses ?? [];
  const allExpenses = allExpensesQuery.data?.expenses ?? [];
  const splitFriends = useMemo(() => uniqueNames(splitNames), [splitNames]);

  const categories = useMemo(() => {
    const dynamic = allExpenses.map((expense) => expense.category);
    return Array.from(new Set([...DEFAULT_CATEGORIES, ...dynamic])).sort((a, b) => a.localeCompare(b));
  }, [allExpenses]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();

    for (const expense of visibleExpenses) {
      totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountPaise);
    }

    return Array.from(totals.entries())
      .map(([category, totalPaise]) => ({ category, totalPaise }))
      .sort((a, b) => b.totalPaise - a.totalPaise);
  }, [visibleExpenses]);

  const recentExpenseId = useMemo(() => {
    return allExpenses
      .slice()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.id;
  }, [allExpenses]);

  const smartInsights = useMemo(() => {
    if (allExpenses.length === 0) {
      return ["No unusual spend yet."];
    }

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const previousWeekStart = new Date(now);
    previousWeekStart.setDate(now.getDate() - 14);
    const currentWeek = new Map<string, number>();
    const previousWeek = new Map<string, number>();
    const totals = new Map<string, number>();

    for (const expense of allExpenses) {
      const expenseDate = new Date(`${expense.date}T00:00:00`);
      totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountPaise);

      if (expenseDate >= weekStart) {
        currentWeek.set(expense.category, (currentWeek.get(expense.category) ?? 0) + expense.amountPaise);
      } else if (expenseDate >= previousWeekStart) {
        previousWeek.set(expense.category, (previousWeek.get(expense.category) ?? 0) + expense.amountPaise);
      }
    }

    const insights: string[] = [];

    for (const [category, current] of currentWeek) {
      const previous = previousWeek.get(category) ?? 0;

      if (previous > 0 && current >= previous * 1.3) {
        insights.push(`${category} up ${Math.round(((current - previous) / previous) * 100)}% this week.`);
      }
    }

    for (const [category, total] of totals) {
      if (total >= REVIEW_LIMIT_PAISE) {
        insights.push(`${category} exceeded ${formatInr(REVIEW_LIMIT_PAISE)} review limit.`);
      }
    }

    return insights.slice(0, 2).length > 0 ? insights.slice(0, 2) : ["No unusual spend yet."];
  }, [allExpenses]);

  const savePendingQueue = (queue: PendingExpense[]) => {
    writePendingQueue(queue);
    setPendingQueue(queue);
  };

  const resetDraftKey = () => {
    const nextId = createId();
    window.localStorage.setItem(DRAFT_KEY, nextId);
    setClientRequestId(nextId);
  };

  const releaseSubmitLock = () => {
    submitLockRef.current = false;
    setIsSubmitLocked(false);
  };

  const resetExpenseForm = (category = getValues("category") || "Groceries") => {
    reset(defaultFormValues(category));
    setSplitEnabled(false);
    setSplitMode("equal");
    setSplitNames("");
    setExactShares({});
    setEditingExpense(null);
    releaseSubmitLock();
    resetDraftKey();
  };

  const buildExpensePayload = (values: ExpenseFormValues): ExpensePayload => ({
    ...values,
    clientRequestId,
    split:
      splitEnabled && splitFriends.length > 0
        ? splitMode === "equal"
          ? {
              mode: "equal",
              friends: splitFriends
            }
          : {
              mode: "exact",
              shares: splitFriends.map((friendName) => ({
                friendName,
                amount: exactShares[friendName] || ""
              }))
            }
        : undefined
  });

  const handleExpenseSaved = (data: CreateExpenseResponse, showSavedToast = true) => {
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["settlements"] });

    if (showSavedToast) {
      toast.success(data.idempotent ? "Already saved from this submission." : "Expense saved.");
    }

    if (data.alert) {
      toast.warning(data.alert.message);
    }
  };

  const enqueuePendingExpense = (payload: ExpensePayload, lastError?: string) => {
    const nextQueue = [
      ...pendingQueue.filter((item) => item.payload.clientRequestId !== payload.clientRequestId),
      {
        id: payload.clientRequestId,
        payload,
        createdAt: new Date().toISOString(),
        lastError
      }
    ];

    savePendingQueue(nextQueue);
    toast.info("Expense saved locally and queued for sync.");
  };

  const createExpenseMutation = useMutation({
    mutationFn: postExpensePayload,
    onSuccess: (data) => {
      handleExpenseSaved(data);
      setIsExpenseDialogOpen(false);
      resetExpenseForm();
    },
    onError: (error, payload) => {
      if (error instanceof ExpenseSubmitError && error.queueable) {
        enqueuePendingExpense(payload, error.message);
        setIsExpenseDialogOpen(false);
        resetExpenseForm();
        return;
      }

      toast.error(`Failed to add expense: ${error instanceof Error ? error.message : "Could not save the expense."}`);
    },
    onSettled: () => {
      releaseSubmitLock();
    }
  });

  const updateExpenseMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ExpensePayload }) => updateExpensePayload(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["settlements"] });
      toast.success("Expense updated.");
      setIsExpenseDialogOpen(false);
      resetExpenseForm();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update the expense.");
    },
    onSettled: () => {
      releaseSubmitLock();
    }
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: deleteExpenseRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["settlements"] });
      toast.success("Expense deleted.");
      setDeleteTarget(null);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not delete the expense.");
    }
  });

  const ocrMutation = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("receipt", file);
      const response = await fetch("/api/ocr", {
        method: "POST",
        body
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.error || "Receipt scan failed.");
      }

      return payload as {
        fields: ExpenseFormValues & { confidence: number };
      };
    },
    onSuccess: (payload) => {
      reset({
        amount: formatAmountInput(payload.fields.amount),
        category: payload.fields.category,
        description: payload.fields.description,
        date: payload.fields.date
      });
      setEditingExpense(null);
      setSplitEnabled(false);
      setIsExpenseDialogOpen(true);
      toast.info(`Receipt fields filled at ${Math.round(payload.fields.confidence * 100)}% confidence.`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Receipt scan failed.");
    }
  });

  const settleMutation = useMutation({
    mutationFn: async (friendName: string) => {
      const response = await fetch("/api/settlements/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ friendName })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["settlements"] });
      toast.success("Settlement updated.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not settle balance.");
    }
  });

  const syncPendingQueue = async () => {
    if (isSyncingQueue || pendingQueue.length === 0) {
      return;
    }

    if (!window.navigator.onLine) {
      setIsOnline(false);
      toast.warning("You are offline. Queued expenses will sync when the network returns.");
      return;
    }

    setIsSyncingQueue(true);
    const remaining: PendingExpense[] = [];
    let syncedCount = 0;

    for (const item of pendingQueue) {
      try {
        const data = await postExpensePayload(item.payload);
        handleExpenseSaved(data, false);
        syncedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not sync this expense.";
        remaining.push({
          ...item,
          lastError: message
        });

        if (!(error instanceof ExpenseSubmitError) || !error.queueable) {
          toast.error(message);
        }
      }
    }

    savePendingQueue(remaining);
    setIsSyncingQueue(false);

    if (syncedCount > 0) {
      toast.success(`Synced ${syncedCount} queued expense${syncedCount === 1 ? "" : "s"}.`);
    }
  };

  const openAddDialog = () => {
    resetExpenseForm(getValues("category") || "Groceries");
    setEditingExpense(null);
    setIsExpenseDialogOpen(true);
  };

  const openEditDialog = (expense: Expense) => {
    setEditingExpense(expense);
    reset({
      amount: formatAmountInput(expense.amount),
      category: expense.category,
      description: expense.description,
      date: expense.date
    });
    setSplitEnabled(expense.splitShares.length > 0);
    setSplitMode("exact");
    setSplitNames(expense.splitShares.map((share) => share.friendName).join(", "));
    setExactShares(
      Object.fromEntries(expense.splitShares.map((share) => [share.friendName, formatAmountInput(share.amount)]))
    );
    setIsExpenseDialogOpen(true);
  };

  const onSubmitExpense = handleSubmit((values) => {
    if (submitLockRef.current || createExpenseMutation.isPending || updateExpenseMutation.isPending) {
      return;
    }

    submitLockRef.current = true;
    setIsSubmitLocked(true);

    const payload = buildExpensePayload({
      ...values,
      amount: formatAmountInput(values.amount)
    });
    const amountPaise = amountToPaise(values.amount);

    if (splitEnabled && splitMode === "exact") {
      const exactTotal = splitFriends.reduce((sum, friendName) => sum + (amountToPaise(exactShares[friendName] || "") ?? 0), 0);
      const missingShare = splitFriends.some((friendName) => !amountToPaise(exactShares[friendName] || ""));

      if (missingShare) {
        toast.error("Enter each exact split amount.");
        releaseSubmitLock();
        return;
      }

      if (amountPaise && exactTotal > amountPaise) {
        toast.error("Split shares cannot exceed the expense amount.");
        releaseSubmitLock();
        return;
      }
    }

    if (editingExpense) {
      updateExpenseMutation.mutate({ id: editingExpense.id, payload });
      return;
    }

    if (!window.navigator.onLine) {
      setIsOnline(false);
      enqueuePendingExpense(payload, "Waiting for network.");
      setIsExpenseDialogOpen(false);
      resetExpenseForm();
      releaseSubmitLock();
      return;
    }

    createExpenseMutation.mutate(payload);
  });

  useEffect(() => {
    const existing = window.localStorage.getItem(DRAFT_KEY);
    const nextId = existing || createId();
    window.localStorage.setItem(DRAFT_KEY, nextId);
    setClientRequestId(nextId);
    setPendingQueue(readPendingQueue());
    setIsOnline(window.navigator.onLine);
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void syncPendingQueue();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [pendingQueue, isSyncingQueue]);

  const currentTotal = expensesQuery.data?.totalPaise ?? 0;
  const isAdding = createExpenseMutation.isPending || (isSubmitLocked && !editingExpense);
  const isSaving = updateExpenseMutation.isPending || (isSubmitLocked && Boolean(editingExpense));
  const isBusy =
    createExpenseMutation.isPending || updateExpenseMutation.isPending || isSyncingQueue || isSubmitLocked || formState.isSubmitting;
  const maxCategoryTotal = Math.max(...categoryTotals.map((item) => item.totalPaise), 1);

  return (
    <main className="min-h-screen">
      <Toaster richColors position="top-right" />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.14em] text-mint">Personal finance</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal text-ink md:text-4xl">Expense Tracker</h1>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <button
              type="button"
              onClick={openAddDialog}
              className="col-span-2 inline-flex min-h-[72px] items-center justify-center gap-2 rounded-md bg-mint px-5 text-sm font-semibold text-white shadow-soft transition hover:bg-[#0d665f] sm:col-span-1"
            >
              <Plus className="h-4 w-4" />
              Add Expense
            </button>
            <div className="rounded-md border border-black/10 bg-white px-4 py-3 shadow-soft">
              <p className="text-xs font-medium text-black/55">Visible total</p>
              <p className="mt-1 text-xl font-semibold text-ink">{formatInr(currentTotal)}</p>
            </div>
            <div className="rounded-md border border-black/10 bg-white px-4 py-3 shadow-soft">
              <p className="text-xs font-medium text-black/55">Rows</p>
              <p className="mt-1 text-xl font-semibold text-ink">{visibleExpenses.length}</p>
            </div>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          <FeatureCard
            title="Offline Queue"
            body={`${pendingQueue.length} pending · ${isOnline ? "Online" : "Offline"}`}
            icon={<RefreshCw className={`h-5 w-5 text-mint ${isSyncingQueue ? "animate-spin" : ""}`} />}
            action={
              <button
                type="button"
                onClick={() => void syncPendingQueue()}
                disabled={pendingQueue.length === 0 || isSyncingQueue}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-semibold text-ink transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Sync queued expenses"
              >
                <RefreshCw className={`h-4 w-4 ${isSyncingQueue ? "animate-spin" : ""}`} />
              </button>
            }
          />
          <FeatureCard
            title="Receipt OCR"
            body={ocrMutation.isPending ? "Scanning receipt" : "Upload image to auto-fill form"}
            icon={<ReceiptText className="h-5 w-5 text-mint" />}
            action={
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={ocrMutation.isPending}
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-mint/25 px-3 text-sm font-semibold text-mint transition hover:bg-mint/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ocrMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Scan Receipt
              </button>
            }
          />
          <FeatureCard
            title="Smart Alerts"
            body={smartInsights[0]}
            icon={<AlertTriangle className="h-5 w-5 text-coral" />}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";

              if (file) {
                ocrMutation.mutate(file);
              }
            }}
          />
        </section>

        <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft transition sm:p-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <h2 className="text-lg font-semibold text-ink">Expenses</h2>
            <div className="grid gap-3 sm:grid-cols-[minmax(180px,240px)_minmax(180px,220px)_auto_auto]">
              <label className="relative">
                <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/45" />
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className="min-h-10 w-full rounded-md border border-black/15 bg-white pl-9 pr-3 text-sm font-medium text-ink transition focus:border-mint"
                >
                  <option value="">All categories</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>

              <label className="relative">
                <ArrowDownWideNarrow className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/45" />
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                  className="min-h-10 w-full rounded-md border border-black/15 bg-white pl-9 pr-3 text-sm font-semibold text-ink transition focus:border-mint"
                >
                  <option value="date_desc">Date: newest</option>
                  <option value="date_asc">Date: oldest</option>
                  <option value="amount_desc">Amount: high to low</option>
                </select>
              </label>

              <button
                type="button"
                onClick={() => expensesQuery.refetch()}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/15 px-3 text-sm font-semibold text-ink transition hover:bg-black/5"
              >
                <RefreshCw className={`h-4 w-4 ${expensesQuery.isFetching ? "animate-spin" : ""}`} />
                Refresh
              </button>

              <button
                type="button"
                onClick={() => exportCsv(visibleExpenses)}
                disabled={visibleExpenses.length === 0}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/15 px-3 text-sm font-semibold text-ink transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
            </div>
          </div>

          <div className="mt-4 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[840px] border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-[0.12em] text-black/45">
                  <th className="border-b border-black/10 py-3 pr-4 font-semibold">Date</th>
                  <th className="border-b border-black/10 px-4 py-3 font-semibold">Description</th>
                  <th className="border-b border-black/10 px-4 py-3 font-semibold">Category</th>
                  <th className="border-b border-black/10 px-4 py-3 font-semibold">Split</th>
                  <th className="border-b border-black/10 px-4 py-3 text-right font-semibold">Amount</th>
                  <th className="border-b border-black/10 py-3 pl-4 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {expensesQuery.isLoading ? (
                  <TableSkeleton />
                ) : expensesQuery.isError ? (
                  <tr>
                    <td className="py-10 text-center text-coral" colSpan={6}>
                      Failed to load expenses
                    </td>
                  </tr>
                ) : visibleExpenses.length === 0 ? (
                  <tr>
                    <td className="py-10 text-center text-black/55" colSpan={6}>
                      No expenses yet
                    </td>
                  </tr>
                ) : (
                  visibleExpenses.map((expense) => (
                    <tr
                      key={expense.id}
                      className={`align-top transition hover:bg-black/[0.025] ${
                        expense.id === recentExpenseId ? "bg-mint/[0.045]" : ""
                      }`}
                    >
                      <td className="border-b border-black/5 py-4 pr-4 font-medium text-black/65">{expense.date}</td>
                      <td className="border-b border-black/5 px-4 py-4">
                        <p className="max-w-[280px] font-medium text-ink">{expense.description}</p>
                      </td>
                      <td className="border-b border-black/5 px-4 py-4">
                        <CategoryPill category={expense.category} />
                      </td>
                      <td className="border-b border-black/5 px-4 py-4">
                        <SplitBadges shares={expense.splitShares} />
                      </td>
                      <td className="border-b border-black/5 px-4 py-4 text-right font-semibold text-ink">
                        {formatInr(expense.amountPaise)}
                      </td>
                      <td className="border-b border-black/5 py-4 pl-4">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openEditDialog(expense)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-black/65 transition hover:border-mint/30 hover:bg-mint/10 hover:text-mint"
                            aria-label={`Edit ${expense.description}`}
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(expense)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-black/65 transition hover:border-coral/30 hover:bg-coral/10 hover:text-coral"
                            aria-label={`Delete ${expense.description}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-3 md:hidden">
            {expensesQuery.isLoading ? (
              <div className="grid gap-3">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="rounded-md border border-black/10 p-3">
                    <div className="h-4 w-2/3 animate-pulse rounded bg-black/10" />
                    <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-black/10" />
                    <div className="mt-4 h-9 animate-pulse rounded bg-black/10" />
                  </div>
                ))}
              </div>
            ) : visibleExpenses.length === 0 ? (
              <p className="rounded-md border border-dashed border-black/15 px-3 py-6 text-center text-sm text-black/50">
                No expenses yet
              </p>
            ) : (
              visibleExpenses.map((expense) => (
                <article
                  key={expense.id}
                  className={`rounded-md border border-black/10 p-3 transition ${
                    expense.id === recentExpenseId ? "bg-mint/[0.055]" : "bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{expense.description}</p>
                      <p className="mt-1 text-xs font-medium text-black/50">{expense.date}</p>
                    </div>
                    <p className="text-base font-semibold text-ink">{formatInr(expense.amountPaise)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <CategoryPill category={expense.category} />
                    <SplitBadges shares={expense.splitShares} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => openEditDialog(expense)}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 text-sm font-semibold text-ink transition hover:bg-black/5"
                    >
                      <Edit3 className="h-4 w-4" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(expense)}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-coral/20 text-sm font-semibold text-coral transition hover:bg-coral/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-2">
          <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft sm:p-5">
            <h2 className="text-lg font-semibold text-ink">Category Summary</h2>
            <div className="mt-4 grid gap-3">
              {categoryTotals.length === 0 ? (
                <p className="rounded-md border border-dashed border-black/15 px-3 py-6 text-center text-sm text-black/50">
                  No category totals
                </p>
              ) : (
                categoryTotals.map((item) => (
                  <div key={item.category} className="grid gap-2 rounded-md bg-[#f9fbf8] px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-ink">{item.category}</span>
                      <span className="text-sm font-semibold text-mint">{formatInr(item.totalPaise)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-black/5">
                      <div
                        className="h-full rounded-full bg-mint transition-all"
                        style={{ width: `${Math.max(8, (item.totalPaise / maxCategoryTotal) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft sm:p-5">
            <h2 className="text-lg font-semibold text-ink">Smart Alerts</h2>
            <div className="mt-4 grid gap-2">
              {smartInsights.map((insight) => (
                <div key={insight} className="flex min-h-12 items-start gap-3 rounded-md bg-coral/10 px-3 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-coral" />
                  <p className="text-sm font-medium leading-5 text-ink">{insight}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft sm:p-5 xl:col-span-2">
            <h2 className="text-lg font-semibold text-ink">Settlements</h2>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {settlementsQuery.isLoading ? (
                <p className="rounded-md border border-dashed border-black/15 px-3 py-6 text-center text-sm text-black/50">
                  Loading settlements
                </p>
              ) : (settlementsQuery.data?.settlements ?? []).length === 0 ? (
                <p className="rounded-md border border-dashed border-black/15 px-3 py-6 text-center text-sm text-black/50 md:col-span-2">
                  No pending balances
                </p>
              ) : (
                settlementsQuery.data?.settlements.map((settlement) => (
                  <div
                    key={settlement.friendName}
                    className="grid gap-3 rounded-md bg-[#f9fbf8] px-3 py-3 sm:grid-cols-[1fr_auto]"
                  >
                    <div>
                      <p className="font-medium text-ink">{settlement.friendName}</p>
                      <p className="text-sm text-black/55">
                        Owes {formatInr(settlement.owesUserPaise)} across {settlement.expenseCount} expense
                        {settlement.expenseCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => settleMutation.mutate(settlement.friendName)}
                      disabled={settleMutation.isPending}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/15 px-3 text-sm font-semibold text-ink transition hover:bg-black/5 disabled:opacity-60"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Settled
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {isExpenseDialogOpen ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/35 px-4 py-6 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="expense-dialog-title"
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-md border border-black/10 bg-white p-4 shadow-soft sm:p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="expense-dialog-title" className="text-lg font-semibold text-ink">
                  {editingExpense ? "Edit Expense" : "Add Expense"}
                </h2>
                <p className="mt-1 text-sm text-black/55">
                  Scan a receipt or enter the details manually. The form stays retry-safe.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsExpenseDialogOpen(false);
                  resetExpenseForm();
                }}
                className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-md border border-black/10 text-black/60 transition hover:bg-black/5"
                aria-label="Close expense dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmitExpense}>
              <label className="grid gap-1.5 text-sm font-medium text-ink">
                Amount
                <Controller
                  name="amount"
                  control={control}
                  render={({ field }) => (
                    <div className="relative">
                      <IndianRupee className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/45" />
                      <input
                        value={field.value}
                        onChange={(event) => field.onChange(sanitizeAmount(event.target.value))}
                        onBlur={() => field.onChange(formatAmountInput(field.value))}
                        inputMode="decimal"
                        placeholder="1,249"
                        className="min-h-11 w-full rounded-md border border-black/15 bg-white pl-9 pr-3 text-sm text-ink transition placeholder:text-black/35 focus:border-mint"
                      />
                    </div>
                  )}
                />
                {formState.errors.amount ? <FieldError message={formState.errors.amount.message} /> : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium text-ink">
                  Category
                  <select
                    {...register("category")}
                    className="min-h-11 rounded-md border border-black/15 bg-white px-3 text-sm text-ink transition focus:border-mint"
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  {formState.errors.category ? <FieldError message={formState.errors.category.message} /> : null}
                </label>

                <label className="grid gap-1.5 text-sm font-medium text-ink">
                  Date
                  <input
                    {...register("date")}
                    type="date"
                    className="min-h-11 rounded-md border border-black/15 bg-white px-3 text-sm text-ink transition focus:border-mint"
                  />
                  {formState.errors.date ? <FieldError message={formState.errors.date.message} /> : null}
                </label>
              </div>

              <label className="grid gap-1.5 text-sm font-medium text-ink">
                Description
                <textarea
                  {...register("description")}
                  rows={3}
                  placeholder="e.g., Swiggy order, Uber ride, Grocery store"
                  className="min-h-24 resize-none rounded-md border border-black/15 bg-white px-3 py-2 text-sm text-ink transition placeholder:text-black/35 focus:border-mint"
                />
                {formState.errors.description ? <FieldError message={formState.errors.description.message} /> : null}
              </label>

              <div className="rounded-md border border-black/10 bg-[#f9fbf8] p-3">
                <label className="flex min-h-8 items-center justify-between gap-3 text-sm font-medium text-ink">
                  <span className="inline-flex items-center gap-2">
                    <Split className="h-4 w-4 text-coral" />
                    Split
                  </span>
                  <input
                    type="checkbox"
                    checked={splitEnabled}
                    onChange={(event) => setSplitEnabled(event.target.checked)}
                    className="h-5 w-5 accent-mint"
                  />
                </label>

                {splitEnabled ? (
                  <div className="mt-3 grid gap-3">
                    <div className="grid grid-cols-2 rounded-md border border-black/10 bg-white p-1">
                      {(["equal", "exact"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setSplitMode(mode)}
                          className={`min-h-9 rounded px-3 text-sm font-medium capitalize transition ${
                            splitMode === mode ? "bg-ink text-white" : "text-black/65 hover:bg-black/5"
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>

                    <label className="grid gap-1.5 text-sm font-medium text-ink">
                      Friends
                      <input
                        value={splitNames}
                        onChange={(event) => setSplitNames(event.target.value)}
                        placeholder="Asha, Ben"
                        className="min-h-11 rounded-md border border-black/15 bg-white px-3 text-sm text-ink transition placeholder:text-black/35 focus:border-mint"
                      />
                    </label>

                    {splitMode === "exact" && splitFriends.length > 0 ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {splitFriends.map((friendName) => (
                          <label key={friendName} className="grid gap-1.5 text-sm font-medium text-ink">
                            {friendName}
                            <input
                              value={exactShares[friendName] || ""}
                              onChange={(event) =>
                                setExactShares((current) => ({
                                  ...current,
                                  [friendName]: sanitizeAmount(event.target.value)
                                }))
                              }
                              onBlur={(event) =>
                                setExactShares((current) => ({
                                  ...current,
                                  [friendName]: formatAmountInput(event.target.value)
                                }))
                              }
                              inputMode="decimal"
                              placeholder="250"
                              className="min-h-10 rounded-md border border-black/15 bg-white px-3 text-sm text-ink transition placeholder:text-black/35 focus:border-mint"
                            />
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <button
                  type="submit"
                  disabled={isBusy || !clientRequestId}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-mint px-4 text-sm font-semibold text-white transition hover:bg-[#0d665f] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {isSaving ? "Saving..." : isAdding ? "Adding..." : editingExpense ? "Save Changes" : "Add Expense"}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={ocrMutation.isPending}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-mint/25 px-4 text-sm font-semibold text-mint transition hover:bg-mint/10 disabled:opacity-60"
                >
                  {ocrMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
                  Scan Receipt
                </button>
                <button
                  type="button"
                  onClick={() => resetExpenseForm()}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-black/15 px-4 text-sm font-semibold text-ink transition hover:bg-black/5"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-4 py-6 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            className="w-full max-w-md rounded-md border border-black/10 bg-white p-5 shadow-soft"
          >
            <h2 id="delete-dialog-title" className="text-lg font-semibold text-ink">
              Delete Expense
            </h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              Delete "{deleteTarget.description}" for {formatInr(deleteTarget.amountPaise)}? This removes its split shares too.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-semibold text-ink transition hover:bg-black/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteExpenseMutation.mutate(deleteTarget.id)}
                disabled={deleteExpenseMutation.isPending}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-coral px-4 text-sm font-semibold text-white transition hover:bg-[#c75c3d] disabled:opacity-60"
              >
                {deleteExpenseMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function FeatureCard({
  action,
  body,
  icon,
  title
}: {
  action?: React.ReactNode;
  body: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex min-h-24 items-center justify-between gap-3 rounded-md border border-black/10 bg-white px-4 py-3 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-[#f5faf8]">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">{title}</p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold text-ink">{body}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs font-medium text-coral">{message}</p> : null;
}

function TableSkeleton() {
  return (
    <>
      {[0, 1, 2].map((item) => (
        <tr key={item}>
          <td className="border-b border-black/5 py-4 pr-4">
            <div className="h-4 w-24 animate-pulse rounded bg-black/10" />
          </td>
          <td className="border-b border-black/5 px-4 py-4">
            <div className="h-4 w-56 animate-pulse rounded bg-black/10" />
          </td>
          <td className="border-b border-black/5 px-4 py-4">
            <div className="h-7 w-24 animate-pulse rounded bg-black/10" />
          </td>
          <td className="border-b border-black/5 px-4 py-4">
            <div className="h-7 w-48 animate-pulse rounded bg-black/10" />
          </td>
          <td className="border-b border-black/5 px-4 py-4">
            <div className="ml-auto h-4 w-20 animate-pulse rounded bg-black/10" />
          </td>
          <td className="border-b border-black/5 py-4 pl-4">
            <div className="ml-auto h-9 w-20 animate-pulse rounded bg-black/10" />
          </td>
        </tr>
      ))}
    </>
  );
}

function CategoryPill({ category }: { category: string }) {
  return <span className="inline-flex rounded-md bg-mint/10 px-2.5 py-1 text-xs font-semibold text-mint">{category}</span>;
}

function SplitBadges({ shares }: { shares: SplitShare[] }) {
  if (shares.length === 0) {
    return <span className="text-black/35">Solo</span>;
  }

  return (
    <div className="flex max-w-[300px] flex-wrap gap-1.5">
      {shares.map((share) => (
        <span
          key={share.id}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
            share.settledAt ? "bg-black/5 text-black/45" : "bg-coral/10 text-coral"
          }`}
        >
          {share.settledAt ? <CheckCircle2 className="h-3 w-3" /> : <Split className="h-3 w-3" />}
          {share.friendName}: {formatInr(share.amountPaise)}
        </span>
      ))}
    </div>
  );
}
