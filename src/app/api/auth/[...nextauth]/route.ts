/**
 * NextAuth.js (Auth.js v5) catch-all route handler.
 *
 * Handles all authentication requests:
 *   POST /api/auth/signin          — credential sign-in
 *   GET  /api/auth/signin          — sign-in page redirect
 *   GET  /api/auth/callback/google — Google OAuth callback
 *   POST /api/auth/signout         — sign-out
 *   GET  /api/auth/session         — current session
 *   GET  /api/auth/csrf            — CSRF token
 *   GET  /api/auth/providers       — list configured providers
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
