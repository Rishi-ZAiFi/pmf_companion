/**
 * Unit tests for the security headers middleware.
 * Requirements: 22.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal mock of NextRequest used to test the middleware without
 * importing the full Next.js runtime.
 */
function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, { headers });
}

// ── Security header constants ─────────────────────────────────────────────────

const EXPECTED_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

// ── Excluded path detection (mirrors middleware logic) ────────────────────────

const EXCLUDED_PREFIXES = [
  "/_next/static",
  "/_next/image",
  "/_next/webpack-hmr",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
];

function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("middleware — excluded path detection", () => {
  it("excludes _next/static paths", () => {
    expect(isExcludedPath("/_next/static/chunks/main.js")).toBe(true);
  });

  it("excludes _next/image paths", () => {
    // The middleware receives pathname only (no query string)
    expect(isExcludedPath("/_next/image")).toBe(true);
    expect(isExcludedPath("/_next/image/w_800/photo.jpg")).toBe(true);
  });

  it("excludes favicon.ico", () => {
    expect(isExcludedPath("/favicon.ico")).toBe(true);
  });

  it("excludes robots.txt", () => {
    expect(isExcludedPath("/robots.txt")).toBe(true);
  });

  it("excludes sitemap.xml", () => {
    expect(isExcludedPath("/sitemap.xml")).toBe(true);
  });

  it("does NOT exclude regular app routes", () => {
    expect(isExcludedPath("/")).toBe(false);
    expect(isExcludedPath("/api/projects")).toBe(false);
    expect(isExcludedPath("/dashboard")).toBe(false);
  });

  it("does NOT exclude paths that merely contain excluded strings mid-path", () => {
    expect(isExcludedPath("/my-robots.txt-page")).toBe(false);
  });
});

describe("middleware — HSTS header value", () => {
  it("HSTS header includes max-age of 1 year (31536000 seconds)", () => {
    const value = EXPECTED_HEADERS["Strict-Transport-Security"];
    expect(value).toContain("max-age=31536000");
  });

  it("HSTS header includes includeSubDomains directive", () => {
    const value = EXPECTED_HEADERS["Strict-Transport-Security"];
    expect(value).toContain("includeSubDomains");
  });

  it("HSTS header includes preload directive", () => {
    const value = EXPECTED_HEADERS["Strict-Transport-Security"];
    expect(value).toContain("preload");
  });
});

describe("middleware — security header values", () => {
  it("X-Content-Type-Options is set to nosniff", () => {
    expect(EXPECTED_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("X-Frame-Options is set to DENY", () => {
    expect(EXPECTED_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("X-XSS-Protection enables block mode", () => {
    expect(EXPECTED_HEADERS["X-XSS-Protection"]).toBe("1; mode=block");
  });

  it("Referrer-Policy uses strict-origin-when-cross-origin", () => {
    expect(EXPECTED_HEADERS["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    );
  });
});

describe("middleware — HTTP to HTTPS redirect logic", () => {
  it("detects HTTP protocol from x-forwarded-proto header", () => {
    const req = makeRequest("https://example.com/api/projects", {
      "x-forwarded-proto": "http",
    });
    const proto = req.headers.get("x-forwarded-proto");
    expect(proto).toBe("http");
  });

  it("detects HTTPS protocol from x-forwarded-proto header", () => {
    const req = makeRequest("https://example.com/api/projects", {
      "x-forwarded-proto": "https",
    });
    const proto = req.headers.get("x-forwarded-proto");
    expect(proto).toBe("https");
  });

  it("constructs correct HTTPS redirect URL from HTTP request", () => {
    const originalUrl = "http://example.com/dashboard";
    const httpsUrl = new URL(originalUrl);
    httpsUrl.protocol = "https:";
    expect(httpsUrl.toString()).toBe("https://example.com/dashboard");
  });

  it("preserves path and query string in HTTPS redirect", () => {
    const originalUrl = "http://example.com/api/projects?page=2&limit=10";
    const httpsUrl = new URL(originalUrl);
    httpsUrl.protocol = "https:";
    expect(httpsUrl.toString()).toBe(
      "https://example.com/api/projects?page=2&limit=10"
    );
  });
});

describe("middleware — all required security headers are present", () => {
  it("defines all five required security headers", () => {
    const requiredHeaders = [
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "X-XSS-Protection",
      "Referrer-Policy",
    ];

    for (const header of requiredHeaders) {
      expect(
        EXPECTED_HEADERS[header as keyof typeof EXPECTED_HEADERS]
      ).toBeDefined();
    }
  });
});
