import { createSSEResponse } from "@/lib/sse";
import { watchBook, fetchBookSnapshot } from "@/lib/watchers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const coin = searchParams.get("coin");

  if (!coin) {
    return Response.json({ error: "coin param required" }, { status: 400 });
  }

  if (searchParams.get("snapshot") === "true") {
    const book = await fetchBookSnapshot(coin);
    return Response.json({ book });
  }

  return createSSEResponse(async (send) => {
    // Send initial snapshot
    try {
      const snapshot = await fetchBookSnapshot(coin);
      send("book", snapshot);
    } catch {
      // Will get data from watcher
    }

    const unsubscribe = await watchBook(coin, (book) => {
      send("book", book);
    });

    return async () => {
      await unsubscribe();
    };
  });
}
