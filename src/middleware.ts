import { NextRequest, NextResponse } from "next/server";

/**
 * Security headers middleware
 *
 * Enforces TLS 1.2+ at the browser level via HSTS and adds standard
 * security headers to all responses. In production, HTTP requests are
 * redirected to HTTPS.
 *
 * TLS 1.2+ at the transport layer is enforced by the deployment/CDN:
 * - Vercel: TLS 1.2+ enforced by default on all deployments
 * - AWS CloudFront: configure Security Policy to TLSv1.2_2021 or higher
 *
 * Requirements: 22.2
 */

// Routes that should be excluded from middleware processing
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

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Skip static files and Next.js internals
  if (isExcludedPath(pathname)) {
    return NextResponse.next();
  }

  // In production, redirect HTTP to HTTPS
  if (process.env.NODE_ENV === "production") {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto === "http") {
      const httpsUrl = new URL(request.url);
      httpsUrl.protocol = "https:";
      return NextResponse.redirect(httpsUrl.toString(), { status: 301 });
    }
  }

  const response = NextResponse.next();

  // HTTP Strict Transport Security
  // max-age=31536000 (1 year), includeSubDomains, preload
  // Instructs browsers to only connect via HTTPS for the next year
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );

  // Prevent MIME type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking by disallowing framing
  response.headers.set("X-Frame-Options", "DENY");

  // Legacy XSS protection for older browsers
  response.headers.set("X-XSS-Protection", "1; mode=block");

  // Control referrer information sent with requests
  response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, robots.txt, sitemap.xml (public files)
     *
     * The regex below matches everything that doesn't start with
     * the excluded prefixes, letting Next.js handle those directly.
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)",
  ],
};
