import { prisma } from "./db";
import { paiseToDecimal } from "./money";
import { settleFriendSchema } from "./schemas";

export async function listSettlements() {
  const grouped = await prisma.splitShare.groupBy({
    by: ["friendName"],
    where: {
      settledAt: null
    },
    _sum: {
      amountPaise: true
    },
    _count: {
      _all: true
    },
    orderBy: {
      friendName: "asc"
    }
  });

  return {
    status: 200,
    body: {
      settlements: grouped.map((item) => ({
        friendName: item.friendName,
        owesUser: paiseToDecimal(item._sum.amountPaise ?? 0),
        owesUserPaise: item._sum.amountPaise ?? 0,
        expenseCount: item._count._all
      }))
    }
  };
}

export async function settleFriend(payload: unknown) {
  const parsed = settleFriendSchema.safeParse(payload);

  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: "Validation failed.",
        details: parsed.error.flatten()
      }
    };
  }

  const result = await prisma.splitShare.updateMany({
    where: {
      friendName: parsed.data.friendName,
      settledAt: null
    },
    data: {
      settledAt: new Date()
    }
  });

  return {
    status: 200,
    body: {
      settledCount: result.count
    }
  };
}
