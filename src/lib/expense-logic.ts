import { createHash } from "crypto";
import { formatInrFromPaise } from "./money";

export type SplitInput =
  | {
      mode: "equal";
      friends: string[];
    }
  | {
      mode: "exact";
      shares: Array<{
        friendName: string;
        amountPaise: number;
      }>;
    };

export type SplitShareInput = {
  friendName: string;
  amountPaise: number;
};

export type SmartAlert = {
  kind: "category_spike";
  message: string;
  ratio: number;
};

export function normalizeFriendName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawName of names) {
    const name = normalizeFriendName(rawName);
    const key = name.toLocaleLowerCase("en-IN");

    if (name && !seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }

  return result;
}

export function buildSplitShares(split: SplitInput | undefined, amountPaise: number): SplitShareInput[] {
  if (!split) {
    return [];
  }

  if (split.mode === "equal") {
    const friends = uniqueNames(split.friends);

    if (friends.length === 0) {
      return [];
    }

    const friendShare = Math.floor(amountPaise / (friends.length + 1));

    if (friendShare <= 0) {
      throw new Error("Split amount is too small for the number of people.");
    }

    return friends.map((friendName) => ({
      friendName,
      amountPaise: friendShare
    }));
  }

  const shares = split.shares.map((share) => ({
    friendName: normalizeFriendName(share.friendName),
    amountPaise: share.amountPaise
  }));
  const names = uniqueNames(shares.map((share) => share.friendName));

  if (names.length !== shares.length) {
    throw new Error("Each split participant must have a unique name.");
  }

  const totalShared = shares.reduce((sum, share) => sum + share.amountPaise, 0);

  if (shares.some((share) => !share.friendName || share.amountPaise <= 0)) {
    throw new Error("Each exact split share needs a friend and a positive amount.");
  }

  if (totalShared > amountPaise) {
    throw new Error("Split shares cannot exceed the expense amount.");
  }

  return shares;
}

export function buildAnomalyAlert(input: {
  amountPaise: number;
  averagePaise: number | null;
  expenseCount: number;
  category: string;
}): SmartAlert | null {
  if (!input.averagePaise || input.expenseCount < 3) {
    return null;
  }

  const ratio = input.amountPaise / input.averagePaise;

  if (ratio < 3) {
    return null;
  }

  return {
    kind: "category_spike",
    ratio,
    message: `${formatInrFromPaise(input.amountPaise)} is ${ratio.toFixed(1)}x your usual ${input.category} spend.`
  };
}

export function hashExpenseRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function parseExpenseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
