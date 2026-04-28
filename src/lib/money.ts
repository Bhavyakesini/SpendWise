export const MAX_PAISE = 2_147_483_647;

export function parseMoneyToPaise(value: string | number): number {
  const normalized = String(value).trim().replace(/[₹,\s]/g, "");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a positive amount with up to 2 decimal places.");
  }

  const [rupees, paise = ""] = normalized.split(".");
  const total = BigInt(rupees) * 100n + BigInt(paise.padEnd(2, "0"));

  if (total <= 0n || total > BigInt(MAX_PAISE)) {
    throw new Error("Amount must be greater than 0 and below the supported limit.");
  }

  return Number(total);
}

export function paiseToDecimal(paise: number): string {
  return (paise / 100).toFixed(2);
}

export function formatInrFromPaise(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(paise / 100);
}
