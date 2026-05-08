import { NextRequest } from "next/server";
import { eq, and, gt, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications } from "@/db/schema/notifications";
import { requireAuth } from "@/lib/require-auth";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * How often (in milliseconds) the SSE endpoint polls the notifications table
 * for new unread notifications.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * How often (in milliseconds) to send a keep-alive comment to prevent the
 * connection from being closed by proxies or load balancers.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Maximum connection lifetime in milliseconds. After this time the stream is
 * closed gracefully so the client can reconnect. This prevents stale
 * connections from accumulating on serverless platforms.
 */
const MAX_CONNECTION_MS = 55_000;

// ── SSE helpers ──────────────────────────────────────────────────────────────

/**
 * Formats a Server-Sent Events message.
 *
 * @param event - The event name (e.g. "notification", "ping").
 * @param data  - The JSON-serialisable payload.
 */
function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE keep-alive comment line. */
const SSE_KEEPALIVE = ": keep-alive\n\n";

// ── GET /api/notifications/stream ────────────────────────────────────────────

/**
 * Server-Sent Events endpoint for real-time in-app notification delivery.
 *
 * The client connects once and receives a stream of `notification` events
 * whenever new unread notifications are created for the authenticated account.
 * The endpoint polls the `notifications` table every 5 seconds and pushes any
 * new records since the last poll.
 *
 * Protocol:
 *   - `event: connected`  — sent immediately on connection with the current
 *                           timestamp so the client can confirm the stream is live.
 *   - `event: notification` — sent for each new unread notification.
 *   - `: keep-alive`      — SSE comment sent every 30 s to prevent proxy timeouts.
 *
 * The stream closes automatically after ~55 seconds (before Vercel's 60-second
 * function timeout). Clients should reconnect using the EventSource API's
 * built-in reconnection logic.
 *
 * Responses:
 *   200 — text/event-stream
 *   401 — Not authenticated (JSON).
 */
export async function GET(request: NextRequest): Promise<Response> {
  // ── 1. Authenticate ──────────────────────────────────────────────────────
  const authResult = await requireAuth(request);
  if (!authResult.ok) {
    // Return the NextResponse from requireAuth directly.
    return authResult.response;
  }

  const { accountId } = authResult;

  // ── 2. Set up the SSE stream ─────────────────────────────────────────────
  const encoder = new TextEncoder();

  // Track the most recent notification createdAt we have seen so we only push
  // genuinely new records on each poll cycle.
  let lastSeenAt: Date = new Date();

  const stream = new ReadableStream({
    async start(controller) {
      // Helper: enqueue encoded SSE text.
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Controller may already be closed if the client disconnected.
        }
      };

      // Send the initial "connected" event so the client knows the stream is live.
      enqueue(
        sseMessage("connected", {
          connectedAt: new Date().toISOString(),
          message: "Notification stream connected",
        }),
      );

      let closed = false;

      // ── Keep-alive timer ───────────────────────────────────────────────
      const keepAliveTimer = setInterval(() => {
        if (closed) return;
        enqueue(SSE_KEEPALIVE);
      }, KEEPALIVE_INTERVAL_MS);

      // ── Max-lifetime timer ─────────────────────────────────────────────
      // Close the stream gracefully before the serverless function times out.
      const maxLifetimeTimer = setTimeout(() => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        clearInterval(pollTimer);
        enqueue(sseMessage("close", { reason: "max_connection_time_reached" }));
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }, MAX_CONNECTION_MS);

      // ── Poll timer ─────────────────────────────────────────────────────
      const pollTimer = setInterval(async () => {
        if (closed) return;

        try {
          // Query for unread notifications created after the last seen timestamp.
          const newNotifications = await db
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.accountId, accountId),
                eq(notifications.isRead, false),
                gt(notifications.createdAt, lastSeenAt),
              ),
            )
            .orderBy(desc(notifications.createdAt));

          if (newNotifications.length > 0) {
            // Advance the cursor to the most recent notification we just fetched.
            // The results are ordered DESC so the first element is the newest.
            lastSeenAt = newNotifications[0].createdAt;

            // Push each notification as a separate SSE event so the client can
            // process them individually.
            for (const notification of newNotifications.reverse()) {
              enqueue(sseMessage("notification", notification));
            }
          }
        } catch (err) {
          // Log but don't crash the stream — a transient DB error should not
          // disconnect the client.
          console.error(
            "[GET /api/notifications/stream] Poll error:",
            err,
          );
        }
      }, POLL_INTERVAL_MS);

      // ── Cleanup on client disconnect ───────────────────────────────────
      // The AbortSignal fires when the client closes the connection.
      request.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        clearInterval(pollTimer);
        clearTimeout(maxLifetimeTimer);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable buffering on Nginx/Vercel proxies.
      "X-Accel-Buffering": "no",
    },
  });
}
