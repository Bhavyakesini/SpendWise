import { createWorker, PSM } from "tesseract.js";
import englishData from "@tesseract.js-data/eng";
import path from "node:path";

export type ReceiptFields = {
  amount: string;
  category: string;
  description: string;
  date: string;
  confidence: number;
};

export type ReceiptExtraction = {
  fields: ReceiptFields;
  fallback: boolean;
  rawText: string;
  source: "tesseract.js";
};

const CATEGORY_RULES = [
  { pattern: /(grocery|grocer|mart|super|kirana)/i, category: "Groceries" },
  { pattern: /(cafe|coffee|restaurant|dine|pizza|food|swiggy|zomato|hotel|express|misal|wada)/i, category: "Food" },
  { pattern: /(uber|ola|taxi|metro|fuel|bus|train)/i, category: "Transport" },
  { pattern: /(pharma|doctor|clinic|health)/i, category: "Health" },
  { pattern: /(movie|ticket|game|event)/i, category: "Entertainment" }
];

const MERCHANT_EXCLUSIONS = /(date|bill|table|particular|qty|rate|amount|subtotal|sub total|total|cgst|sgst|gst|thank|invoice|tax)/i;
const ITEM_EXCLUSIONS =
  /(date|bill|table|particular|qty|rate|amount|subtotal|sub total|total|cgst|sgst|gst|thank|visit|invoice|tax|restaurant|highway|near|opp\.?|road|street|pada|thane|mumbai|nashik|bhiwandi|bus stop)/i;

function normalizeText(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function getLines(text: string) {
  return normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function toIsoDate(raw: string) {
  const match = raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);

  if (!match) {
    return "";
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);

  if (year < 100) {
    year += year <= 69 ? 2000 : 1900;
  }

  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return "";
  }

  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDate(text: string) {
  const isoDate = text.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/)?.[0];

  if (isoDate) {
    return isoDate;
  }

  return toIsoDate(text);
}

function parseMoney(value: string) {
  const normalized = value.replace(/,/g, "");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

function moneyToField(value: number) {
  return value.toFixed(2);
}

function amountsFromLine(line: string) {
  return Array.from(line.matchAll(/\b\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?\b/g))
    .map((match) => parseMoney(match[0]))
    .filter((amount): amount is number => amount !== null);
}

function parseAmount(lines: string[]) {
  const priorityLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      /(grand\s+total|net\s+total|amount\s+due|balance\s+due|\btotal\b|\bmota\b)/i.test(line) &&
      !/(sub\s*total|food\s+total|cgst|sgst|tax)/i.test(lower)
    );
  });

  for (const line of priorityLines.reverse()) {
    const amounts = amountsFromLine(line).filter((amount) => amount > 0);

    if (amounts.length > 0) {
      return moneyToField(Math.max(...amounts));
    }
  }

  const allAmounts = lines.flatMap(amountsFromLine).filter((amount) => amount > 0);

  if (allAmounts.length === 0) {
    return "";
  }

  return moneyToField(Math.max(...allAmounts));
}

function merchantScore(line: string) {
  const letters = line.replace(/[^a-z]/gi, "");
  const words = line.match(/[A-Z][A-Z&.'-]{2,}/g) ?? [];
  let score = letters.length + words.length * 8;

  if (/(restaurant|cafe|mart|store|hotel|express|foods?|kirana|pharma)/i.test(line)) {
    score += 35;
  }

  if (MERCHANT_EXCLUSIONS.test(line)) {
    score -= 60;
  }

  if (line.length < 4 || letters.length < 4) {
    score -= 40;
  }

  return score;
}

function parseMerchant(lines: string[]) {
  const candidates = lines
    .slice(0, 12)
    .map((line) => ({ line, score: merchantScore(line) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.line.replace(/[^a-z0-9&.' -]/gi, "").replace(/\s+/g, " ").trim() ?? "";
}

function parseItems(lines: string[]) {
  return lines
    .map((line) => {
      if (ITEM_EXCLUSIONS.test(line) || amountsFromLine(line).length === 0) {
        return "";
      }

      return line
        .replace(/\b\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?\b/g, "")
        .replace(/[^a-z&.' -]/gi, " ")
        .replace(/\b[a-z]\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter((item) => item.length >= 4)
    .slice(0, 3);
}

function parseCategory(text: string) {
  return CATEGORY_RULES.find((rule) => rule.pattern.test(text))?.category ?? "Miscellaneous";
}

function buildDescription(merchant: string, items: string[]) {
  if (merchant && items.length > 0) {
    return `${merchant} - ${items.join(", ")}`.slice(0, 180);
  }

  return merchant || items.join(", ") || "Receipt expense";
}

export function parseReceiptText(rawText: string, ocrConfidence = 0): ReceiptExtraction {
  const text = normalizeText(rawText);
  const lines = getLines(text);
  const merchant = parseMerchant(lines);
  const items = parseItems(lines);
  const amount = parseAmount(lines);
  const date = parseDate(text);
  const category = parseCategory(text);
  const presentFields = [amount, date, merchant].filter(Boolean).length;
  const confidence = Math.max(0.15, Math.min(0.99, (ocrConfidence || 0) / 100 || presentFields / 4));

  return {
    fields: {
      amount,
      category,
      description: buildDescription(merchant, items),
      date,
      confidence
    },
    fallback: !amount || !date,
    rawText: text,
    source: "tesseract.js"
  };
}

export async function scanReceiptImage(image: Buffer): Promise<ReceiptExtraction> {
  const worker = await createWorker("eng", 1, {
    workerPath: path.join(process.cwd(), "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js"),
    corePath: path.join(process.cwd(), "node_modules", "tesseract.js-core"),
    langPath: englishData.langPath,
    gzip: englishData.gzip
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO
    });
    const result = await worker.recognize(image);
    return parseReceiptText(result.data.text, result.data.confidence);
  } finally {
    await worker.terminate();
  }
}
