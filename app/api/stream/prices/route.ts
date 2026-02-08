import { createSSEResponse } from "@/lib/sse";
import { watchPrices } from "@/lib/watchers";
import { getAllMids } from "@/lib/hyperliquid";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("snapshot") === "true") {
    const mids = await getAllMids();
    return Response.json({ mids });
  }

  // Optional: filter to specific coins
  const coinsParam = searchParams.get("coins");
  const filterCoins = coinsParam ? coinsParam.split(",") : null;

  return createSSEResponse(async (send) => {
    // Send initial snapshot
    try {
      const mids = await getAllMids();
      send("prices", mids);
    } catch {
      // Will get data from watcher
    }

    const unsubscribe = await watchPrices((prices) => {
      if (filterCoins) {
        const filtered: Record<string, unknown> = {};
        for (const coin of filterCoins) {
          if (prices[coin]) filtered[coin] = prices[coin];
        }
        send("prices", filtered);
      } else {
        send("prices", prices);
      }
    });

    return async () => {
      await unsubscribe();
    };
  });
}
