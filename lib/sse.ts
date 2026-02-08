/**
 * SSE (Server-Sent Events) Helpers
 *
 * Utility for creating SSE responses from Next.js API routes.
 * Each SSE route connects to a watcher and streams data to the client.
 */

export function createSSEResponse(
  setup: (send: (event: string, data: unknown) => void) => Promise<() => void>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // stream closed
        }
      };

      // Send initial keepalive
      send("connected", { timestamp: Date.now() });

      // Keepalive every 30s to prevent timeout
      const keepalive = setInterval(() => {
        send("ping", { timestamp: Date.now() });
      }, 30_000);

      let cleanup: (() => void) | undefined;

      try {
        const teardown = await setup(send);
        cleanup = () => {
          clearInterval(keepalive);
          teardown();
        };
      } catch (error) {
        clearInterval(keepalive);
        send("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
        controller.close();
        return;
      }

      // Handle stream cancellation
      const checkClosed = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n")); // SSE comment as heartbeat
        } catch {
          clearInterval(checkClosed);
          cleanup?.();
        }
      }, 15_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
