/**
 * /optout?token=...
 *
 * Public opt-out confirmation page. No authentication required.
 *
 * This page is linked from every outbound email and SMS. When a contact
 * visits this URL, it calls the /api/optout endpoint to process the opt-out
 * and displays a confirmation message.
 *
 * Requirements: 22.5
 */

import { Suspense } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OptOutResult {
  success: boolean;
  channel?: string;
  message?: string;
  error?: string;
}

// ── Server-side opt-out processing ────────────────────────────────────────────

/**
 * Process the opt-out server-side by calling the API endpoint.
 * Returns the result to render in the page.
 */
async function processOptOut(token: string | undefined): Promise<OptOutResult> {
  if (!token) {
    return {
      success: false,
      error: "No opt-out token was provided. Please use the link from your email or SMS.",
    };
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const response = await fetch(`${baseUrl}/api/optout?token=${encodeURIComponent(token)}`, {
      method: "GET",
      cache: "no-store",
    });

    const data = (await response.json()) as OptOutResult;
    return data;
  } catch {
    return {
      success: false,
      error: "Unable to process your opt-out request. Please try again later.",
    };
  }
}

// ── Page component ────────────────────────────────────────────────────────────

interface OptOutPageProps {
  searchParams: Promise<{ token?: string }>;
}

async function OptOutContent({ token }: { token: string | undefined }) {
  const result = await processOptOut(token);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#f9fafb",
        fontFamily: "Arial, sans-serif",
        padding: "20px",
      }}
    >
      <div
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          padding: "48px 40px",
          maxWidth: "480px",
          width: "100%",
          textAlign: "center",
        }}
      >
        {result.success ? (
          <>
            {/* Success state */}
            <div
              style={{
                width: "56px",
                height: "56px",
                borderRadius: "50%",
                backgroundColor: "#d1fae5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 24px",
                fontSize: "28px",
              }}
              aria-hidden="true"
            >
              ✓
            </div>
            <h1
              style={{
                fontSize: "22px",
                fontWeight: "600",
                color: "#111827",
                margin: "0 0 12px",
              }}
            >
              You&apos;ve been opted out
            </h1>
            <p
              style={{
                fontSize: "15px",
                color: "#6b7280",
                lineHeight: "1.6",
                margin: "0 0 24px",
              }}
            >
              {result.message ??
                "You will no longer receive outreach messages from this project."}
            </p>
            <p
              style={{
                fontSize: "13px",
                color: "#9ca3af",
                lineHeight: "1.5",
                margin: "0",
              }}
            >
              If you opted out by mistake or have questions, please reply to the
              original message or contact the sender directly.
            </p>
          </>
        ) : (
          <>
            {/* Error state */}
            <div
              style={{
                width: "56px",
                height: "56px",
                borderRadius: "50%",
                backgroundColor: "#fee2e2",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 24px",
                fontSize: "28px",
              }}
              aria-hidden="true"
            >
              ✕
            </div>
            <h1
              style={{
                fontSize: "22px",
                fontWeight: "600",
                color: "#111827",
                margin: "0 0 12px",
              }}
            >
              Opt-out could not be processed
            </h1>
            <p
              style={{
                fontSize: "15px",
                color: "#6b7280",
                lineHeight: "1.6",
                margin: "0 0 24px",
              }}
            >
              {result.error ??
                "We were unable to process your opt-out request. The link may have expired."}
            </p>
            <p
              style={{
                fontSize: "13px",
                color: "#9ca3af",
                lineHeight: "1.5",
                margin: "0",
              }}
            >
              Opt-out links are valid for 90 days. If you need assistance, please
              reply directly to the original message.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default async function OptOutPage({ searchParams }: OptOutPageProps) {
  const params = await searchParams;
  const token = params.token;

  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#f9fafb",
            fontFamily: "Arial, sans-serif",
          }}
        >
          <p style={{ color: "#6b7280", fontSize: "15px" }}>Processing your request…</p>
        </div>
      }
    >
      <OptOutContent token={token} />
    </Suspense>
  );
}

export const metadata = {
  title: "Opt Out | Market Signal Platform",
  description: "Opt out of outreach messages from Market Signal Platform.",
  robots: "noindex, nofollow",
};
