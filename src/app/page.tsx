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

type SortKey = "created_desc" | "date_desc" | "date_asc" | "amount_desc";
type TrendRange = "7d" | "30d" | "6m";
type AnalyticsTab = "trend" | "yearly";

type DateFilter = {
  from: string;
  to: string;
  label: string;
};

type SmartInsight = {
  id: string;
  message: string;
  expenseId: string | null;
  category?: string;
  severity: "info" | "warning" | "critical";
};

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

type TrendPoint = {
  label: string;
  shortLabel: string;
  totalPaise: number;
  from: string;
  to: string;
  isCurrent: boolean;
};

const DEFAULT_CATEGORIES = [
  "Groceries",
  "Food",
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
const HIDDEN_CATEGORIES = new Set(["Dining"]);
const DRAFT_KEY = "expense-tracker-draft-id";
const OFFLINE_QUEUE_KEY = "expense-tracker-offline-queue";
const ALERT_LIMIT_KEY = "expense-tracker-alert-limit";
const DEFAULT_REVIEW_LIMIT_INPUT = "500";
const DEFAULT_REVIEW_LIMIT_PAISE = 50_000;
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TREND_RANGE_LABELS: Record<TrendRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "6m": "Last 6 months"
};

const expenseFormSchema = z.object({
  amount: z.string().refine((value) => amountToPaise(value) !== null, "Enter a positive amount."),
  category: z.string().trim().min(1, "Choose a category."),
  description: z.string().trim().max(180, "Keep it under 180 characters."),
  date: z
    .string()
    .trim()
    .min(1, "Choose a date.")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
});

type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

function today() {
  return toDateOnly(new Date());
}

function toDateOnly(date: Date) {
  const now = new Date();
  const value = date || now;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function normalizeCategoryOption(category: string) {
  const trimmed = category.trim();

  if (!trimmed) {
    return "Groceries";
  }

  return HIDDEN_CATEGORIES.has(trimmed) ? "Food" : trimmed;
}

function defaultFormValues(category = "Groceries"): ExpenseFormValues {
  return {
    amount: "",
    category: normalizeCategoryOption(category),
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

async function fetchExpenses(category: string, sort: SortKey, dateFilter?: DateFilter | null): Promise<ExpensesResponse> {
  const params = new URLSearchParams();

  if (category) {
    params.set("category", category);
  }

  if (dateFilter) {
    params.set("date_from", dateFilter.from);
    params.set("date_to", dateFilter.to);
  }

  params.set("sort", sort);

  const response = await fetch(`/api/expenses?${params.toString()}`, {
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
    response = await fetch("/api/expenses", {
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
  const response = await fetch(`/api/expenses/${id}`, {
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
  const response = await fetch(`/api/expenses/${id}`, {
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

function sumExpensesBetween(expenses: Expense[], from: string, to: string) {
  return expenses.reduce((sum, expense) => {
    return expense.date >= from && expense.date <= to ? sum + expense.amountPaise : sum;
  }, 0);
}

function dayLabel(date: Date) {
  return `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}`;
}

function buildTrendPoints(expenses: Expense[], range: TrendRange): TrendPoint[] {
  const now = new Date();
  const todayValue = toDateOnly(now);

  if (range === "6m") {
    return Array.from({ length: 6 }, (_, index) => {
      const monthDate = startOfMonth(addMonths(now, index - 5));
      const from = toDateOnly(monthDate);
      const to = toDateOnly(endOfMonth(monthDate));
      const label = `${MONTH_LABELS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

      return {
        label,
        shortLabel: MONTH_LABELS[monthDate.getMonth()],
        totalPaise: sumExpensesBetween(expenses, from, to),
        from,
        to,
        isCurrent: monthDate.getMonth() === now.getMonth() && monthDate.getFullYear() === now.getFullYear()
      };
    });
  }

  const length = range === "7d" ? 7 : 30;

  return Array.from({ length }, (_, index) => {
    const date = addDays(now, index - (length - 1));
    const dateValue = toDateOnly(date);

    return {
      label: dayLabel(date),
      shortLabel: range === "7d" ? dayLabel(date) : String(date.getDate()),
      totalPaise: sumExpensesBetween(expenses, dateValue, dateValue),
      from: dateValue,
      to: dateValue,
      isCurrent: dateValue === todayValue
    };
  });
}

export default function Home() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const smartAlertsRef = useRef<HTMLElement | null>(null);
  const submitLockRef = useRef(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("created_desc");
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
  const [focusedExpenseId, setFocusedExpenseId] = useState<string | null>(null);
  const [pendingFocusExpenseId, setPendingFocusExpenseId] = useState<string | null>(null);
  const [isRefreshingData, setIsRefreshingData] = useState(false);
  const [alertLimitInput, setAlertLimitInput] = useState(DEFAULT_REVIEW_LIMIT_INPUT);
  const [trendRange, setTrendRange] = useState<TrendRange>("6m");
  const [analyticsTab, setAnalyticsTab] = useState<AnalyticsTab>("trend");
  const [dateFilter, setDateFilter] = useState<DateFilter | null>(null);
  const [isSmartAlertsFocused, setIsSmartAlertsFocused] = useState(false);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseFormSchema),
    defaultValues: defaultFormValues(),
    mode: "onBlur"
  });
  const { control, formState, handleSubmit, register, reset, setValue, getValues } = form;

  const expensesQuery = useQuery({
    queryKey: ["expenses", categoryFilter, sort, dateFilter?.from ?? "", dateFilter?.to ?? ""],
    queryFn: () => fetchExpenses(categoryFilter, sort, dateFilter)
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
  const settlements = settlementsQuery.data?.settlements ?? [];
  const showSettlements = settlementsQuery.isLoading || settlements.length > 0;
  const splitFriends = useMemo(() => uniqueNames(splitNames), [splitNames]);
  const alertLimitPaise = useMemo(() => amountToPaise(alertLimitInput) ?? DEFAULT_REVIEW_LIMIT_PAISE, [alertLimitInput]);

  const categories = useMemo(() => {
    const dynamic = allExpenses.map((expense) => expense.category).filter((category) => !HIDDEN_CATEGORIES.has(category));
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

  const spendingOverview = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIndex = now.getMonth();
    const monthlyTotals = MONTH_LABELS.map((month, index) => ({
      month,
      totalPaise: 0,
      isCurrent: index === currentMonthIndex
    }));
    const yearlyTotals = new Map<number, number>();

    for (const expense of allExpenses) {
      const [yearValue, monthValue] = expense.date.split("-");
      const year = Number(yearValue);
      const monthIndex = Number(monthValue) - 1;

      if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) {
        continue;
      }

      yearlyTotals.set(year, (yearlyTotals.get(year) ?? 0) + expense.amountPaise);

      if (year === currentYear) {
        monthlyTotals[monthIndex].totalPaise += expense.amountPaise;
      }
    }

    const yearlyBreakdown = Array.from(yearlyTotals.entries())
      .map(([year, totalPaise]) => ({ year, totalPaise }))
      .sort((a, b) => b.year - a.year);

    return {
      currentMonthIndex,
      currentMonthLabel: `${MONTH_LABELS[currentMonthIndex]} ${currentYear}`,
      currentMonthTotalPaise: monthlyTotals[currentMonthIndex]?.totalPaise ?? 0,
      currentYear,
      currentYearTotalPaise: yearlyTotals.get(currentYear) ?? 0,
      maxMonthTotalPaise: Math.max(...monthlyTotals.map((item) => item.totalPaise), 1),
      maxYearTotalPaise: Math.max(...yearlyBreakdown.map((item) => item.totalPaise), 1),
      monthlyTotals,
      previousMonthTotalPaise: currentMonthIndex > 0 ? monthlyTotals[currentMonthIndex - 1]?.totalPaise ?? 0 : 0,
      yearlyBreakdown
    };
  }, [allExpenses]);

  const trendAnalytics = useMemo(() => {
    const points = buildTrendPoints(allExpenses, trendRange);
    const currentPoint = points.find((point) => point.isCurrent) ?? points[points.length - 1];
    const currentIndex = Math.max(
      points.findIndex((point) => point.from === currentPoint?.from && point.to === currentPoint?.to),
      0
    );
    const previousPoint = points[Math.max(currentIndex - 1, 0)];
    const maxTotalPaise = Math.max(...points.map((point) => point.totalPaise), 1);
    const highestPoint = points.slice().sort((a, b) => b.totalPaise - a.totalPaise)[0] ?? null;
    const lowestPoint = points.slice().sort((a, b) => a.totalPaise - b.totalPaise)[0] ?? null;
    const hasData = points.some((point) => point.totalPaise > 0);

    return {
      currentPoint,
      previousPoint,
      points,
      maxTotalPaise,
      highestPoint,
      lowestPoint,
      hasData
    };
  }, [allExpenses, trendRange]);

  const recentExpenseId = useMemo(() => {
    return allExpenses
      .slice()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.id;
  }, [allExpenses]);

  const smartInsights = useMemo<SmartInsight[]>(() => {
    if (allExpenses.length === 0) {
      return [
        {
          id: "empty",
          message: "No unusual spend yet.",
          expenseId: null,
          severity: "info"
        }
      ];
    }

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const previousWeekStart = new Date(now);
    previousWeekStart.setDate(now.getDate() - 14);
    const currentWeek = new Map<string, number>();
    const previousWeek = new Map<string, number>();
    const totals = new Map<string, number>();
    const categoryExpenses = new Map<string, Expense[]>();

    for (const expense of allExpenses) {
      const expenseDate = new Date(`${expense.date}T00:00:00`);
      totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountPaise);
      categoryExpenses.set(expense.category, [...(categoryExpenses.get(expense.category) ?? []), expense]);

      if (expenseDate >= weekStart) {
        currentWeek.set(expense.category, (currentWeek.get(expense.category) ?? 0) + expense.amountPaise);
      } else if (expenseDate >= previousWeekStart) {
        previousWeek.set(expense.category, (previousWeek.get(expense.category) ?? 0) + expense.amountPaise);
      }
    }

    const insights: SmartInsight[] = [];

    for (const [category, current] of currentWeek) {
      const previous = previousWeek.get(category) ?? 0;

      if (previous > 0 && current >= previous * 1.3) {
        const triggerExpense = (categoryExpenses.get(category) ?? [])
          .slice()
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.amountPaise - a.amountPaise)[0];
        insights.push({
          id: `week-${category}`,
          message: `${category} up ${Math.round(((current - previous) / previous) * 100)}% this week.`,
          expenseId: triggerExpense?.id ?? null,
          category,
          severity: "warning"
        });
      }
    }

    for (const [category, total] of totals) {
      if (total >= alertLimitPaise) {
        const triggerExpense = (categoryExpenses.get(category) ?? [])
          .slice()
          .sort((a, b) => b.amountPaise - a.amountPaise || Date.parse(b.date) - Date.parse(a.date))[0];
        const isCritical = total >= alertLimitPaise * 2;
        insights.push({
          id: `limit-${category}`,
          message: isCritical
            ? `${category} is ${formatInr(total)}, over 2x the ${formatInr(alertLimitPaise)} limit.`
            : `${category} exceeded ${formatInr(alertLimitPaise)} review limit.`,
          expenseId: triggerExpense?.id ?? null,
          category,
          severity: isCritical ? "critical" : "warning"
        });
      }
    }

    return insights.slice(0, 2).length > 0
      ? insights.slice(0, 2)
      : [
          {
            id: "none",
            message: "No unusual spend yet.",
            expenseId: null,
            severity: "info"
          }
        ];
  }, [alertLimitPaise, allExpenses]);

  const focusExpense = (insight: SmartInsight) => {
    if (!insight.expenseId) {
      return;
    }

    setPendingFocusExpenseId(insight.expenseId);
    setFocusedExpenseId(insight.expenseId);
    window.setTimeout(() => {
      setFocusedExpenseId((current) => (current === insight.expenseId ? null : current));
    }, 2600);
  };

  const scrollToSmartAlerts = () => {
    setIsSmartAlertsFocused(true);
    smartAlertsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setIsSmartAlertsFocused(false), 2200);
  };

  const applyTrendPointFilter = (point: TrendPoint) => {
    setDateFilter({
      from: point.from,
      to: point.to,
      label: point.label
    });
    setSort("date_desc");
    toast.info(`Showing expenses for ${point.label}.`);
  };

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
    reset(defaultFormValues(normalizeCategoryOption(category)));
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
    category: normalizeCategoryOption(values.category),
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
    setSort("created_desc");
    setFocusedExpenseId(data.expense.id);
    setPendingFocusExpenseId(data.expense.id);

    if (showSavedToast) {
      toast.success(data.idempotent ? "Already saved from this submission." : "Expense saved.");
    }

    if (data.alert) {
      toast.warning(data.alert.message);
    }
  };

  const handleAlertLimitChange = (value: string) => {
    const nextLimit = sanitizeAmount(value);
    setAlertLimitInput(nextLimit);

    if (amountToPaise(nextLimit)) {
      window.localStorage.setItem(ALERT_LIMIT_KEY, formatAmountInput(nextLimit));
    }
  };

  const handleAlertLimitBlur = () => {
    const nextLimit = amountToPaise(alertLimitInput) ? formatAmountInput(alertLimitInput) : DEFAULT_REVIEW_LIMIT_INPUT;
    setAlertLimitInput(nextLimit);
    window.localStorage.setItem(ALERT_LIMIT_KEY, nextLimit);
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
        category: normalizeCategoryOption(payload.fields.category),
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

  const refreshDashboard = async () => {
    if (isRefreshingData) {
      return;
    }

    setIsRefreshingData(true);

    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["expenses"], type: "active" }),
        queryClient.refetchQueries({ queryKey: ["settlements"], type: "active" })
      ]);
      toast.success("Dashboard refreshed.");
    } catch {
      toast.error("Failed to refresh dashboard.");
    } finally {
      setIsRefreshingData(false);
    }
  };

  const resetDashboardView = () => {
    setCategoryFilter("");
    setSort("created_desc");
    setDateFilter(null);
    setFocusedExpenseId(null);
    setPendingFocusExpenseId(null);
    toast.info("View reset.");
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
      category: normalizeCategoryOption(expense.category),
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

    const savedAlertLimit = window.localStorage.getItem(ALERT_LIMIT_KEY);

    if (savedAlertLimit && amountToPaise(savedAlertLimit)) {
      setAlertLimitInput(formatAmountInput(savedAlertLimit));
    }
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

  useEffect(() => {
    if (!pendingFocusExpenseId || expensesQuery.isFetching) {
      return;
    }

    if (!visibleExpenses.some((expense) => expense.id === pendingFocusExpenseId)) {
      setPendingFocusExpenseId(null);
      return;
    }

    const targets = Array.from(document.querySelectorAll<HTMLElement>(`[data-expense-id="${pendingFocusExpenseId}"]`));
    const visibleTarget = targets.find((target) => target.offsetParent !== null) ?? targets[0];

    if (visibleTarget) {
      visibleTarget.scrollIntoView({ behavior: "smooth", block: "center" });
      setPendingFocusExpenseId(null);
    }
  }, [pendingFocusExpenseId, visibleExpenses, expensesQuery.isFetching]);

  const currentTotal = expensesQuery.data?.totalPaise ?? 0;
  const isAdding = createExpenseMutation.isPending || (isSubmitLocked && !editingExpense);
  const isSaving = updateExpenseMutation.isPending || (isSubmitLocked && Boolean(editingExpense));
  const isBusy =
    createExpenseMutation.isPending || updateExpenseMutation.isPending || isSyncingQueue || isSubmitLocked || formState.isSubmitting;
  const maxCategoryTotal = Math.max(...categoryTotals.map((item) => item.totalPaise), 1);
  const expenseErrorMessage = expensesQuery.error instanceof Error ? expensesQuery.error.message : "Failed to load expenses.";

  return (
    <main className="min-h-screen">
      <Toaster richColors position="top-right" />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <img
              src="/logo.png"
              alt="SpendWise logo"
              className="h-16 w-16 flex-none rounded-2xl border border-black/10 bg-white object-cover shadow-soft md:h-20 md:w-20"
            />
            <div>
              <h1 className="text-4xl font-semibold tracking-normal text-ink md:text-5xl">SpendWise</h1>
              <p className="mt-1 text-base font-medium text-black/55">Track smarter. Spend wiser.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex sm:items-stretch">
            <button
              type="button"
              onClick={openAddDialog}
              className="col-span-2 inline-flex min-h-[68px] min-w-[220px] items-center justify-center gap-3 rounded-md bg-mint px-9 text-base font-semibold text-white shadow-soft transition hover:bg-[#0d665f] sm:col-span-1"
            >
              <Plus className="h-5 w-5" />
              Add Expense
            </button>
            <div className="min-w-[240px] rounded-md border border-black/10 bg-white px-7 py-3.5 shadow-soft">
              <p className="text-sm font-medium text-black/55">Total expenditure</p>
              <p className="mt-1 text-2xl font-semibold text-ink md:text-3xl">{formatInr(currentTotal)}</p>
            </div>
          </div>
        </header>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.35fr)_minmax(0,1fr)]">
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
                className="inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md border border-mint/25 px-4 text-sm font-semibold text-mint transition hover:bg-mint/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ocrMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Scan Receipt
              </button>
            }
          />
          <FeatureCard
            title="Smart Alerts"
            body={smartInsights[0].message}
            icon={<AlertTriangle className={`h-5 w-5 ${severityTextClass(smartInsights[0].severity)}`} />}
            onClick={scrollToSmartAlerts}
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
                  <option value="created_desc">Newest added</option>
                  <option value="date_desc">Date: newest</option>
                  <option value="date_asc">Date: oldest</option>
                  <option value="amount_desc">Amount: high to low</option>
                </select>
              </label>

              <button
                type="button"
                onClick={resetDashboardView}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/15 px-3 text-sm font-semibold text-ink transition hover:bg-black/5"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
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

              {dateFilter ? (
                <button
                  type="button"
                  onClick={() => setDateFilter(null)}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-mint/20 bg-mint/10 px-3 text-sm font-semibold text-mint transition hover:bg-mint/15 sm:col-span-full xl:col-span-1"
                >
                  {dateFilter.label}
                  <X className="h-4 w-4" />
                </button>
              ) : null}
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
                    <td className="py-8" colSpan={6}>
                      <ExpenseErrorState message={expenseErrorMessage} onRetry={() => void refreshDashboard()} />
                    </td>
                  </tr>
                ) : visibleExpenses.length === 0 ? (
                  <tr>
                    <td className="py-10 text-center text-black/55" colSpan={6}>
                      No expenses yet. Add your first expense.
                    </td>
                  </tr>
                ) : (
                  visibleExpenses.map((expense) => (
                    <tr
                      key={expense.id}
                      data-expense-id={expense.id}
                      className={`align-top transition hover:bg-mint/[0.05] hover:shadow-sm ${
                        expense.id === focusedExpenseId
                          ? "bg-coral/10 ring-2 ring-coral/30"
                          : expense.id === recentExpenseId
                            ? "bg-mint/[0.08]"
                            : ""
                      }`}
                    >
                      <td className="border-b border-black/5 py-4 pr-4 font-medium text-black/65">{expense.date}</td>
                      <td className="border-b border-black/5 px-4 py-4">
                        <div className="flex max-w-[280px] flex-wrap items-center gap-2">
                          <p className="font-medium text-ink">{expense.description || "No description"}</p>
                          {expense.id === recentExpenseId ? (
                            <span className="rounded-full bg-mint/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-mint">
                              Newest
                            </span>
                          ) : null}
                        </div>
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
                            aria-label={`Edit ${expense.description || "expense"}`}
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(expense)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-black/65 transition hover:border-coral/30 hover:bg-coral/10 hover:text-coral"
                            aria-label={`Delete ${expense.description || "expense"}`}
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
            ) : expensesQuery.isError ? (
              <ExpenseErrorState message={expenseErrorMessage} onRetry={() => void refreshDashboard()} />
            ) : visibleExpenses.length === 0 ? (
              <p className="rounded-md border border-dashed border-black/15 px-3 py-6 text-center text-sm text-black/50">
                No expenses yet. Add your first expense.
              </p>
            ) : (
              visibleExpenses.map((expense) => (
                <article
                  key={expense.id}
                  data-expense-id={expense.id}
                  className={`rounded-md border border-black/10 p-3 transition hover:border-mint/25 hover:shadow-soft ${
                    expense.id === focusedExpenseId
                      ? "border-coral/30 bg-coral/10 ring-2 ring-coral/25"
                      : expense.id === recentExpenseId
                        ? "border-mint/20 bg-mint/[0.08]"
                        : "bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{expense.description || "No description"}</p>
                        {expense.id === recentExpenseId ? (
                          <span className="rounded-full bg-mint/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-mint">
                            Newest
                          </span>
                        ) : null}
                      </div>
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

        <div className="gap-5 xl:columns-2 [&>section]:mb-5 [&>section]:break-inside-avoid">
          <section
            ref={smartAlertsRef}
            className={`rounded-md border bg-white p-4 shadow-soft transition-all duration-300 sm:p-5 ${
              isSmartAlertsFocused ? "border-coral/35 ring-2 ring-coral/20" : "border-black/10"
            }`}
          >
            <h2 className="text-lg font-semibold text-ink">Category Summary</h2>
            <div className="mt-4 grid gap-3">
              {categoryTotals.length === 0 ? (
                <p className="rounded-md border border-dashed border-black/15 px-3 py-4 text-center text-sm text-black/50">
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

          {showSettlements ? (
            <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft transition-all duration-300 sm:p-5">
              <h2 className="text-lg font-semibold text-ink">Settlements</h2>
              <div className="mt-4 grid gap-2">
                {settlementsQuery.isLoading ? (
                  <p className="rounded-md border border-dashed border-black/15 px-3 py-4 text-center text-sm text-black/50">
                    Loading settlements
                  </p>
                ) : (
                  settlements.map((settlement) => (
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
          ) : null}

          <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft transition-all duration-300 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Smart Alerts</h2>
                <p className="mt-1 text-sm font-medium text-black/50">Limit: {formatInr(alertLimitPaise)}</p>
              </div>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-black/45 sm:w-44">
                Review limit
                <div className="relative">
                  <IndianRupee className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/45" />
                  <input
                    value={alertLimitInput}
                    onChange={(event) => handleAlertLimitChange(event.target.value)}
                    onBlur={handleAlertLimitBlur}
                    inputMode="decimal"
                    aria-label="Smart alert review limit"
                    className="min-h-10 w-full rounded-md border border-black/15 bg-white pl-9 pr-3 text-sm font-semibold tracking-normal text-ink transition focus:border-mint"
                  />
                </div>
              </label>
            </div>
            <div className="mt-4 grid gap-2">
              {smartInsights.map((insight) => (
                <button
                  key={insight.id}
                  type="button"
                  onClick={() => focusExpense(insight)}
                  disabled={!insight.expenseId}
                  className={`flex min-h-12 items-start gap-3 rounded-md border px-3 py-3 text-left transition disabled:cursor-default ${severityCardClass(
                    insight.severity
                  )}`}
                >
                  <AlertTriangle className={`mt-0.5 h-4 w-4 flex-none ${severityTextClass(insight.severity)}`} />
                  <div>
                    <p className="text-sm font-semibold leading-5 text-ink">
                      {insight.severity === "critical" ? "Critical" : insight.severity === "warning" ? "Warning" : "Status"}
                    </p>
                    <p className="text-sm font-medium leading-5 text-ink">{insight.message}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-black/10 bg-white p-4 shadow-soft transition-all duration-300 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">Spending Analytics</h2>
                <p className="mt-1 text-sm font-medium text-black/50">All saved expenses</p>
              </div>
              <div className="grid grid-cols-2 rounded-md border border-black/10 bg-white p-1">
                {(["trend", "yearly"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setAnalyticsTab(tab)}
                    className={`min-h-9 rounded px-3 text-sm font-semibold transition ${
                      analyticsTab === tab ? "bg-ink text-white" : "text-black/60 hover:bg-black/5"
                    }`}
                  >
                    {tab === "trend" ? "Trend" : "Yearly"}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-[#f9fbf8] px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">This month</p>
                <p className="mt-1 text-sm font-medium text-black/55">{spendingOverview.currentMonthLabel}</p>
                <p className="mt-2 text-xl font-semibold text-ink">
                  {formatInr(spendingOverview.currentMonthTotalPaise)}
                </p>
              </div>
              <div className="rounded-md bg-[#f9fbf8] px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">This year</p>
                <p className="mt-1 text-sm font-medium text-black/55">{spendingOverview.currentYear}</p>
                <p className="mt-2 text-xl font-semibold text-ink">
                  {formatInr(spendingOverview.currentYearTotalPaise)}
                </p>
              </div>
            </div>

            {analyticsTab === "trend" ? (
              <div className="mt-4 rounded-md border border-mint/15 bg-[#f6fbf9] px-3 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">Spending trend</p>
                    <p className="mt-1 text-sm font-semibold text-ink">
                      {formatTrendChange(trendAnalytics.currentPoint?.totalPaise ?? 0, trendAnalytics.previousPoint?.totalPaise ?? 0)}
                    </p>
                  </div>
                  <select
                    value={trendRange}
                    onChange={(event) => setTrendRange(event.target.value as TrendRange)}
                    className="min-h-9 rounded-md border border-black/15 bg-white px-3 text-sm font-semibold text-ink transition focus:border-mint"
                    aria-label="Trend range"
                  >
                    {(["7d", "30d", "6m"] as const).map((range) => (
                      <option key={range} value={range}>
                        {TREND_RANGE_LABELS[range]}
                      </option>
                    ))}
                  </select>
                </div>

                <SpendingTrendChart
                  points={trendAnalytics.points}
                  maxTotalPaise={trendAnalytics.maxTotalPaise}
                  currentPoint={trendAnalytics.currentPoint}
                  hasData={trendAnalytics.hasData}
                  onPointClick={applyTrendPointFilter}
                />

                {trendAnalytics.hasData ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <ComparisonPill label="Highest spending" point={trendAnalytics.highestPoint} />
                    <ComparisonPill label="Lowest spending" point={trendAnalytics.lowestPoint} />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4">
                <YearlyExpensesPanel
                  items={spendingOverview.yearlyBreakdown}
                  maxTotalPaise={spendingOverview.maxYearTotalPaise}
                />
              </div>
            )}
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
                  aria-busy={isAdding || isSaving}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-mint px-5 text-base font-semibold text-white transition hover:bg-[#0d665f] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
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
              {isAdding || isSaving ? (
                <p className="rounded-md bg-mint/10 px-3 py-2 text-sm font-medium text-mint">
                  {isAdding ? "Adding expense. Please wait..." : "Saving changes. Please wait..."}
                </p>
              ) : null}
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
              Are you sure?
            </h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              Delete "{deleteTarget.description || "this expense"}" for {formatInr(deleteTarget.amountPaise)}? This removes its
              split shares too.
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
  onClick,
  title
}: {
  action?: React.ReactNode;
  body: string;
  icon: React.ReactNode;
  onClick?: () => void;
  title: string;
}) {
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-[#f5faf8]">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">{title}</p>
          <p className="mt-1 text-sm font-semibold leading-5 text-ink">{body}</p>
        </div>
      </div>
      {action ? <div className="flex flex-none justify-end">{action}</div> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-28 items-center justify-between gap-3 rounded-md border border-black/10 bg-white px-5 py-4 text-left shadow-soft transition hover:-translate-y-0.5 hover:shadow-lg"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex min-h-28 items-center justify-between gap-3 rounded-md border border-black/10 bg-white px-5 py-4 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lg">
      {content}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs font-medium text-coral">{message}</p> : null;
}

function ExpenseErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-coral/25 bg-coral/10 px-4 py-5 text-center">
      <AlertTriangle className="mx-auto h-5 w-5 text-coral" />
      <p className="mt-2 text-sm font-semibold text-ink">Failed to load expenses</p>
      <p className="mt-1 text-sm text-black/60">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-coral/25 bg-white px-3 text-sm font-semibold text-coral transition hover:bg-coral/10"
      >
        <RefreshCw className="h-4 w-4" />
        Retry
      </button>
    </div>
  );
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

function formatTrendChange(currentPaise: number, previousPaise: number) {
  const changePaise = currentPaise - previousPaise;

  if (changePaise > 0) {
    if (previousPaise > 0) {
      return `↑ ${Math.round((changePaise / previousPaise) * 100)}% vs previous (+${formatInr(changePaise)})`;
    }

    return `↑ New spend (+${formatInr(changePaise)})`;
  }

  if (changePaise < 0) {
    if (previousPaise > 0) {
      return `↓ ${Math.round((Math.abs(changePaise) / previousPaise) * 100)}% vs previous (-${formatInr(Math.abs(changePaise))})`;
    }

    return `↓ ${formatInr(Math.abs(changePaise))} vs previous`;
  }

  return "No change vs previous";
}

function roundAxisValue(value: number) {
  if (value <= 0) {
    return 0;
  }

  const magnitude = 10 ** Math.max(0, String(Math.floor(value)).length - 2);
  return Math.ceil(value / magnitude) * magnitude;
}

function formatCompactInr(paise: number) {
  const rupees = paise / 100;

  if (rupees >= 100_000) {
    return `₹${(rupees / 100_000).toFixed(1)}L`;
  }

  if (rupees >= 1_000) {
    return `₹${Math.round(rupees / 1_000)}k`;
  }

  return `₹${Math.round(rupees)}`;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  return points.reduce((path, point, index, list) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }

    const previous = list[index - 1];
    const controlDistance = (point.x - previous.x) * 0.45;
    return `${path} C ${previous.x + controlDistance} ${previous.y}, ${point.x - controlDistance} ${point.y}, ${point.x} ${point.y}`;
  }, "");
}

function ComparisonPill({ label, point }: { label: string; point: TrendPoint | null }) {
  return (
    <div className="rounded-md border border-black/10 bg-white px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">
        {point ? `${formatInr(point.totalPaise)} in ${point.label}` : "No spending data"}
      </p>
    </div>
  );
}

function SpendingTrendChart({
  currentPoint,
  hasData,
  maxTotalPaise,
  onPointClick,
  points
}: {
  currentPoint?: TrendPoint;
  hasData: boolean;
  maxTotalPaise: number;
  onPointClick: (point: TrendPoint) => void;
  points: TrendPoint[];
}) {
  const [hoveredPoint, setHoveredPoint] = useState<TrendPoint | null>(null);
  const width = 240;
  const height = 84;
  const topPadding = 10;
  const bottomPadding = 18;
  const usableHeight = height - topPadding - bottomPadding;
  const safeMax = Math.max(maxTotalPaise, 1);
  const chartPoints = points.map((point, index) => {
    const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * width;
    const y = height - bottomPadding - (point.totalPaise / safeMax) * usableHeight;
    return { ...point, x, y };
  });
  const linePath = buildSmoothPath(chartPoints);
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;
  const activePoint =
    chartPoints.find((point) => currentPoint && point.from === currentPoint.from && point.to === currentPoint.to) ??
    chartPoints[chartPoints.length - 1];
  const tooltipPoint = chartPoints.find((point) => hoveredPoint && point.from === hoveredPoint.from && point.to === hoveredPoint.to);
  const yAxisMax = roundAxisValue(safeMax);
  const yAxisMid = Math.round(yAxisMax / 2);
  const shouldShowLabel = (index: number) => points.length <= 7 || index === 0 || index === points.length - 1 || index % 5 === 0;

  return (
    <div className="mt-3 rounded-md bg-white/75 px-3 py-3">
      {!hasData ? (
        <div className="grid min-h-40 place-items-center rounded-md border border-dashed border-black/15 text-sm font-medium text-black/50">
          No spending data available yet
        </div>
      ) : (
        <div className="grid grid-cols-[44px_1fr] gap-2">
          <div className="flex h-40 flex-col justify-between py-1 text-right text-[11px] font-semibold text-black/45">
            <span>{formatCompactInr(yAxisMax)}</span>
            <span>{formatCompactInr(yAxisMid)}</span>
            <span>{formatCompactInr(0)}</span>
          </div>
          <div className="relative">
            {tooltipPoint ? (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-black/10 bg-white px-2 py-1 text-xs font-semibold text-ink shadow-soft"
                style={{
                  left: `${(tooltipPoint.x / width) * 100}%`,
                  top: `${Math.max(0, (tooltipPoint.y / height) * 100 - 18)}%`
                }}
              >
                {tooltipPoint.label}: {formatInr(tooltipPoint.totalPaise)}
              </div>
            ) : null}
            <svg className="h-40 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img">
              <title>Spending trend</title>
              <defs>
                <linearGradient id="trend-stroke" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0%" stopColor="#3bb8a5" />
                  <stop offset="100%" stopColor="#0f766e" />
                </linearGradient>
                <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#128477" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#128477" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[topPadding, topPadding + usableHeight / 2, height - bottomPadding].map((y) => (
                <line key={y} x1="0" x2={width} y1={y} y2={y} stroke="#000" strokeOpacity="0.06" strokeWidth="1" />
              ))}
              <path d={areaPath} fill="url(#trend-fill)" />
              <path
                d={linePath}
                fill="none"
                stroke="url(#trend-stroke)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.6"
              />
              {chartPoints.map((point, index) => {
                const isCurrent = activePoint && point.from === activePoint.from && point.to === activePoint.to;

                return (
                  <g
                    key={`${point.from}-${point.to}-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${point.label}: ${formatInr(point.totalPaise)}`}
                    onClick={() => onPointClick(point)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onPointClick(point);
                      }
                    }}
                    onFocus={() => setHoveredPoint(point)}
                    onBlur={() => setHoveredPoint(null)}
                    onMouseEnter={() => setHoveredPoint(point)}
                    onMouseLeave={() => setHoveredPoint(null)}
                    className="cursor-pointer"
                  >
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={isCurrent ? 4.4 : 3}
                      fill={isCurrent ? "#0f766e" : "#ffffff"}
                      stroke="#128477"
                      strokeWidth={isCurrent ? 2 : 1.4}
                    />
                  </g>
                );
              })}
            </svg>
            <div className="mt-1 grid text-[11px] font-semibold text-black/45" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}>
              {points.map((point, index) => (
                <span key={`${point.from}-${point.to}-${index}-label`} className="truncate text-center">
                  {shouldShowLabel(index) ? (point.isCurrent ? `${point.shortLabel} (Current)` : point.shortLabel) : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {points
          .filter((point) => point.totalPaise > 0)
          .map((point, index) => (
            <button
              key={`${point.from}-${point.to}-${index}-chip`}
              type="button"
              onClick={() => onPointClick(point)}
              className="rounded-full border border-mint/15 bg-mint/10 px-2.5 py-1 text-xs font-semibold text-mint transition hover:bg-mint/15"
            >
              {point.label}: {formatInr(point.totalPaise)}
            </button>
          ))}
      </div>
    </div>
  );
}

function YearlyExpensesPanel({
  items,
  maxTotalPaise
}: {
  items: Array<{ year: number; totalPaise: number }>;
  maxTotalPaise: number;
}) {
  return (
    <div className="rounded-md border border-black/10 bg-[#f9fbf8] px-3 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/45">Yearly expenses</p>
      <div className="mt-3 grid gap-2">
        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-black/15 px-3 py-4 text-center text-sm text-black/50">
            No yearly totals yet
          </p>
        ) : (
          items.map((item) => (
            <div key={item.year} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-ink">{item.year}</span>
                <span className="text-sm font-semibold text-mint">{formatInr(item.totalPaise)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-black/5">
                <div
                  className="h-full rounded-full bg-coral transition-all"
                  style={{
                    width: `${Math.max(6, (item.totalPaise / maxTotalPaise) * 100)}%`
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function severityCardClass(severity: SmartInsight["severity"]) {
  if (severity === "critical") {
    return "border-red-200 bg-red-50 hover:bg-red-100 disabled:hover:bg-red-50";
  }

  if (severity === "warning") {
    return "border-amber-200 bg-amber-50 hover:bg-amber-100 disabled:hover:bg-amber-50";
  }

  return "border-black/10 bg-black/[0.03] hover:bg-black/[0.04] disabled:hover:bg-black/[0.03]";
}

function severityTextClass(severity: SmartInsight["severity"]) {
  if (severity === "critical") {
    return "text-red-600";
  }

  if (severity === "warning") {
    return "text-amber-600";
  }

  return "text-black/50";
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
