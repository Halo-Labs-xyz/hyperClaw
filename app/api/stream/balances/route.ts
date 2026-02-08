import { createSSEResponse } from "@/lib/sse";
import { watchBalances, fetchBalanceSnapshot } from "@/lib/watchers";
import { type Address } from "viem";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user = searchParams.get("user") as Address | null;

  if (!user) {
    return Response.json({ error: "user param required" }, { status: 400 });
  }

  if (searchParams.get("snapshot") === "true") {
    const balance = await fetchBalanceSnapshot(user);
    return Response.json({ balance });
  }

  return createSSEResponse(async (send) => {
    try {
      const snapshot = await fetchBalanceSnapshot(user);
      send("balance", snapshot);
    } catch {
      // Will get data from watcher
    }

    const unsubscribe = await watchBalances(user, (balance) => {
      send("balance", balance);
    });

    return async () => {
      await unsubscribe();
    };
  });
}
