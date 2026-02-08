import { createSSEResponse } from "@/lib/sse";
import { watchOrders } from "@/lib/watchers";
import { getOpenOrders } from "@/lib/hyperliquid";
import { type Address } from "viem";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user = searchParams.get("user") as Address | null;

  if (!user) {
    return Response.json({ error: "user param required" }, { status: 400 });
  }

  if (searchParams.get("snapshot") === "true") {
    const orders = await getOpenOrders(user);
    return Response.json({ orders });
  }

  return createSSEResponse(async (send) => {
    // Send initial snapshot
    try {
      const orders = await getOpenOrders(user);
      send("orders", orders);
    } catch {
      // Will get data from watcher
    }

    const unsubscribe = await watchOrders(user, (orders) => {
      send("orders", orders);
    });

    return async () => {
      await unsubscribe();
    };
  });
}
