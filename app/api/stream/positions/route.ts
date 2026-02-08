import { createSSEResponse } from "@/lib/sse";
import { watchPositions, fetchPositionsSnapshot } from "@/lib/watchers";
import { type Address } from "viem";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user = searchParams.get("user") as Address | null;

  if (!user) {
    return Response.json({ error: "user param required" }, { status: 400 });
  }

  // If client doesn't want SSE, return snapshot
  if (searchParams.get("snapshot") === "true") {
    const positions = await fetchPositionsSnapshot(user);
    return Response.json({ positions });
  }

  return createSSEResponse(async (send) => {
    // Send initial snapshot
    try {
      const snapshot = await fetchPositionsSnapshot(user);
      send("positions", snapshot);
    } catch {
      // Initial fetch failed, will get data from watcher
    }

    const unsubscribe = await watchPositions(user, (positions) => {
      send("positions", positions);
    });

    return async () => {
      await unsubscribe();
    };
  });
}
