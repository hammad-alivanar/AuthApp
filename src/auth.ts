import { SvelteKitAuth } from '@auth/sveltekit';
import Credentials from '@auth/core/providers/credentials';
import Google from '@auth/core/providers/google';
import GitHub from '@auth/core/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '$lib/server/db';
import { user, account, session, verificationToken } from '$lib/server/db/schema';
import { env } from '$env/dynamic/private';
import { eq, and } from 'drizzle-orm';
import { compare } from 'bcryptjs';
import type { User, Account, Profile } from '@auth/core/types';

export const authOptions = {
  adapter: DrizzleAdapter(db, { user, account, session, verificationToken } as any),
  trustHost: true,
  secret: env.AUTH_SECRET,
  debug: true,
  allowDangerousEmailAccountLinking: true, // Allow linking accounts with same email
  session: { 
    strategy: 'database' as const,
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  cookies: {
    sessionToken: {
      name: 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    callbackUrl: {
      name: 'authjs.callback-url',
      options: {
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    csrfToken: {
      name: 'authjs.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    }
  },
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          prompt: 'select_account'
        }
      }
    }),
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
      authorization: {
        params: {
          scope: 'read:user user:email'
        }
      }
    }),
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(creds) {
        if (!creds?.email || !creds?.password) {
          throw new Error("Email and password required");
        }

        const email = creds.email.toString();
        const password = creds.password.toString();

        // Fetch user from database
        const [u] = await db.select().from(user).where(eq(user.email, email.toLowerCase()));
        if (!u) throw new Error("Invalid credentials");
        if (u.disabled) throw new Error("Account disabled");
        if (!u.emailVerified) throw new Error("Email not verified");

        // Check if user has a password (credentials account)
        if (!u.hashedPassword) throw new Error("Invalid credentials");

        const valid = await compare(password, u.hashedPassword);
        if (!valid) throw new Error("Invalid credentials");

        return {
          id: u.id,
          email: u.email,
          name: u.name ?? null,
          image: u.image ?? null,
          role: u.role
        };
      }
    })
  ],
  callbacks: {
    async signIn(params: { user: User; account?: Account | null; profile?: Profile; email?: { verificationRequest?: boolean }; credentials?: Record<string, unknown> }) {
      const { account: authAccount, profile } = params;
      if (!authAccount || authAccount.provider === 'credentials') return true;

      const provider = authAccount.provider;
      const providerAccountId = (authAccount as any)?.providerAccountId as string | undefined;

      // 1) If (provider, providerAccountId) exists, allow login
      if (providerAccountId) {
        const [existingAccount] = await db
          .select()
          .from(account)
          .where(and(eq(account.provider, provider), eq(account.providerAccountId, providerAccountId)));
        if (existingAccount) return true;
      }

      // 2) Get a verified email from the provider
      let email: string | undefined = (profile as any)?.email?.toLowerCase?.();
      let isVerified = false;

      if (provider === 'google') {
        const emailVerifiedGoogle = (profile as any)?.email_verified ?? (profile as any)?.verified_email;
        isVerified = Boolean(email && emailVerifiedGoogle === true);
      } else if (provider === 'github') {
        // Prefer fetching from the /user/emails endpoint to ensure we have a verified email
        try {
          const accessToken = (authAccount as any)?.access_token as string | undefined;
          if (accessToken) {
            const res = await fetch('https://api.github.com/user/emails', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json'
              }
            });
            if (res.ok) {
              const emails: Array<{ email: string; verified: boolean; primary: boolean }> = await res.json();
              const primaryVerified = emails.find((e) => e.primary && e.verified);
              const anyVerified = emails.find((e) => e.verified);
              const chosen = (primaryVerified ?? anyVerified)?.email;
              if (chosen) {
                email = chosen.toLowerCase();
                isVerified = true;
              }
            }
          }
          // Fallback to profile if API call fails but profile.email exists (GitHub may mark it verified on the user object in some cases)
          if (!isVerified && email) {
            const emailVerifiedGithub = (profile as any)?.verified;
            isVerified = Boolean(emailVerifiedGithub === true);
          }
        } catch {
          // Ignore and handle lack of verified email below
        }
      }

      if (!email || !isVerified) {
        // Proper error when provider doesn't give a verified email
        return '/login?error=OAuthEmailNotVerified';
      }

      // 3) If verified email exists in users, link provider -> existing user explicitly
      const [existingUserByEmail] = await db.select().from(user).where(eq(user.email, email));
      if (existingUserByEmail) {
        if (providerAccountId) {
          const [already] = await db
            .select()
            .from(account)
            .where(and(eq(account.provider, provider), eq(account.providerAccountId, providerAccountId)));
          if (!already) {
            try {
              await db.insert(account).values({
                userId: existingUserByEmail.id,
                type: authAccount.type as any,
                provider,
                providerAccountId,
                access_token: (authAccount as any)?.access_token ?? null,
                refresh_token: (authAccount as any)?.refresh_token ?? null,
                expires_at: (authAccount as any)?.expires_at ?? null,
                token_type: (authAccount as any)?.token_type ?? null,
                scope: (authAccount as any)?.scope ?? null,
                id_token: (authAccount as any)?.id_token ?? null,
                session_state: (authAccount as any)?.session_state ?? null
              } as any);
            } catch (e) {
              return '/login?error=OAuthLinkFailed';
            }
          }
        }
        // Log in the linked user
        return true;
      }

      // 4) No existing user — allow adapter to create user + provider account
      return true;
    },

    async session({ session, user }: { session: any; user: any }) {
      if (session.user && user) {
        session.user.id = user.id;
        session.user.role = user.role;
      }
      return session;
    },

    async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {
      // Handle redirects after authentication
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      else if (new URL(url).origin === baseUrl) return url;
      
      // Default redirect after OAuth login - use post-auth handler
      return `${baseUrl}/post-auth`;
    }
  },
  pages: { 
    signIn: '/login',
    signOut: '/login',
    error: '/login'
  },
  events: {
    async signIn(params: { user: User; account?: Account | null; profile?: Profile }) {
      const { user: authUser, account: authAccount, profile } = params;
      // Update user profile information when signing in with OAuth
      if (authAccount && profile && authUser && authUser.id) {
        try {
          const safeString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
          if (authAccount.provider === 'google') {
            await db
              .update(user)
              .set({
                name: safeString((profile as any)?.name) ?? safeString((authUser as any)?.name),
                email: safeString((profile as any)?.email) ?? safeString((authUser as any)?.email),
                image: safeString((profile as any)?.picture) ?? safeString((authUser as any)?.image)
              })
              .where(eq(user.id, String((authUser as any)?.id)));
          } else if (authAccount.provider === 'github') {
            await db
              .update(user)
              .set({
                name: safeString((profile as any)?.name) ?? safeString((authUser as any)?.name),
                email: safeString((profile as any)?.email) ?? safeString((authUser as any)?.email),
                image: safeString((profile as any)?.avatar_url) ?? safeString((authUser as any)?.image)
              })
              .where(eq(user.id, String((authUser as any)?.id)));
          }
        } catch (error) {
          console.error('Error updating user profile:', error);
        }
      }
    },
    async signOut(message: { session: any } | { token: any }) {
      // Clean up any additional data if needed
      console.log('User signed out successfully');
    }
  }
};

export const { handle, signIn, signOut } = SvelteKitAuth(authOptions);