/**
 * NextAuth.js (Auth.js v5) type augmentations.
 *
 * Extends the default Session and JWT types to include the custom fields
 * that are added in the jwt and session callbacks in src/auth.ts.
 */
import type { DefaultSession, DefaultJWT } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      /** NextAuth internal user id (same as accountId for credentials users) */
      id: string;
      /** UUID from the `accounts` table */
      accountId: string;
      /** Billing plan tier: free | starter | growth | enterprise */
      planTier: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    userId: string;
    accountId: string;
    planTier: string;
  }
}
