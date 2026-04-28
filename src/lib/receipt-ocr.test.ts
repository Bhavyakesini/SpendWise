import { describe, expect, it } from "vitest";
import { parseReceiptText } from "./receipt-ocr";

const ZAIKA_OCR_TEXT = `
ZAIKA EXPRESS
Veg Restaurant
NH 3, Mumbai Nashik Highway
Opp.Bhoir Pada Bus Stop, Near Padga
Bhiwandi, Thane
Date: 15/11/25 Bill No: 53
Particulars Qty Rate Amount
MISAL PAV 2 85 170.00
BATATA WADA 1 70 70.00
MEDU WADA 1 80 80.00
Sub Total : 320.00
CGST @9% 28.80
SGST @9% 28.80
Food Total : 377.60
Total : 378.00
THANK YOU Visit Again
`;

describe("receipt OCR parser", () => {
  it("extracts amount, date, category, and description from public OCR text", () => {
    const result = parseReceiptText(ZAIKA_OCR_TEXT, 85);

    expect(result.source).toBe("tesseract.js");
    expect(result.fallback).toBe(false);
    expect(result.fields).toMatchObject({
      amount: "378.00",
      category: "Food",
      date: "2025-11-15",
      description: "ZAIKA EXPRESS - MISAL PAV, BATATA WADA, MEDU WADA"
    });
  });

  it("does not invent amount and date when OCR text lacks evidence", () => {
    const result = parseReceiptText("blurry random upload with no readable totals", 15);

    expect(result.fallback).toBe(true);
    expect(result.fields.amount).toBe("");
    expect(result.fields.date).toBe("");
  });
});
