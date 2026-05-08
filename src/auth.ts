import NextAuth, { type NextAuthConfig, type User } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema/accounts";

/**
 * Extended user type that carries our custom fields through the auth flow.
 * These fields are set in the `authorize` function (credentials) or the
 * `signIn` callback (Google OAuth) and then persisted into the JWT.
 */
interface AppUser extends User {
  accountId: string;
  planTier: string;
}

/**
 * NextAuth.js (Auth.js v5) configuration.
 *
 * Strategy: JWT-only (no database adapter for sessions).
 * - Access token maxAge: 15 minutes (900 seconds)
 * - Session (refresh) maxAge: 7 days (604800 seconds)
 *
 * JWT payload includes:
 *   - userId    — NextAuth internal user id (same as accountId for credentials)
 *   - accountId — UUID from the `accounts` table
 *   - planTier  — current billing plan (free | starter | growth | enterprise)
 */
export const authConfig: NextAuthConfig = {
  providers: [
    /**
     * Email / password credentials provider.
     * Looks up the account by email and verifies the password hash.
     *
     * NOTE: The `passwordHash` column is not in the Drizzle schema yet because
     * the accounts table was designed for OAuth-first. The registration
     * endpoint (task 2.2) will add password support. For now, credentials
     * login returns null when no password hash is stored, gracefully
     * degrading to "invalid credentials".
     */
    Credentials({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials): Promise<AppUser | null> {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        const [account] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.email, email))
          .limit(1);

        if (!account) {
          return null;
        }

        const passwordHash = account.passwordHash ?? undefined;

        if (!passwordHash) {
          // Account exists but was created via OAuth — no password set.
          return null;
        }

        const isValid = await bcrypt.compare(password, passwordHash);
        if (!isValid) {
          return null;
        }

        return {
          id: account.id,
          email: account.email,
          name: account.name ?? undefined,
          accountId: account.id,
          planTier: account.planTier,
        };
      },
    }),

    /**
     * Google OAuth provider.
     * On first sign-in, the signIn callback upserts an account row so that
     * `accountId` and `planTier` are always available in the JWT.
     */
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  /**
   * Use JWT strategy — no database adapter required for sessions.
   * The session cookie holds the encrypted JWT directly.
   */
  session: {
    strategy: "jwt",
    // 7-day sliding window for the session cookie / refresh token
    maxAge: 7 * 24 * 60 * 60, // 604800 seconds
  },

  jwt: {
    // Access token lifetime: 15 minutes
    maxAge: 15 * 60, // 900 seconds
  },

  callbacks: {
    /**
     * Runs on every sign-in attempt.
     * For Google OAuth, upsert the account row so we always have a local
     * `accounts` record with a stable UUID and planTier.
     */
    async signIn({ user, account: oauthAccount }) {
      if (oauthAccount?.provider === "google" && user.email) {
        const [existing] = await db
          .select({ id: accounts.id, planTier: accounts.planTier })
          .from(accounts)
          .where(eq(accounts.email, user.email))
          .limit(1);

        const appUser = user as AppUser;

        if (!existing) {
          // First-time Google sign-in — create the account row
          const [created] = await db
            .insert(accounts)
            .values({
              email: user.email,
              name: user.name ?? null,
            })
            .returning({ id: accounts.id, planTier: accounts.planTier });

          // Attach our internal IDs to the user object so the jwt callback
          // can pick them up.
          appUser.accountId = created.id;
          appUser.planTier = created.planTier;
        } else {
          appUser.accountId = existing.id;
          appUser.planTier = existing.planTier;
        }
      }

      return true;
    },

    /**
     * JWT callback — called whenever a JWT is created or updated.
     * Persists `userId`, `accountId`, and `planTier` into the token so they
     * are available in the session callback and in API route helpers.
     */
    async jwt({ token, user }) {
      if (user) {
        // `user` is only populated on the initial sign-in
        const appUser = user as AppUser;
        token.userId = appUser.id ?? "";
        token.accountId = appUser.accountId ?? appUser.id ?? "";
        token.planTier = appUser.planTier ?? "free";
      }
      return token;
    },

    /**
     * Session callback — shapes the session object exposed to the client.
     * Copies the custom fields from the JWT into `session.user`.
     */
    async session({ session, token }) {
      if (token) {
        session.user.id = token.userId as string;
        session.user.accountId = token.accountId as string;
        session.user.planTier = token.planTier as string;
      }
      return session;
    },
  },

  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
