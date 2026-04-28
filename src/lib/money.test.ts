import { describe, expect, it } from "vitest";
import { parseMoneyToPaise, paiseToDecimal } from "./money";

describe("money helpers", () => {
  it("stores decimal money as integer paise", () => {
    expect(parseMoneyToPaise("123.45")).toBe(12345);
    expect(parseMoneyToPaise("₹1,000.05")).toBe(100005);
  });

  it("rejects invalid money input", () => {
    expect(() => parseMoneyToPaise("-1")).toThrow();
    expect(() => parseMoneyToPaise("12.345")).toThrow();
    expect(() => parseMoneyToPaise("0")).toThrow();
  });

  it("serializes paise consistently", () => {
    expect(paiseToDecimal(1999)).toBe("19.99");
  });
});
