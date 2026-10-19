"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { isClerkPublishableKeyValid, isClerkSecretKeyValid } from "@/lib/auth-keys";

export async function onBoardUser() {
  const isPubValid = isClerkPublishableKeyValid(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const isSecValid = isClerkSecretKeyValid(process.env.CLERK_SECRET_KEY);
  if (!isPubValid || !isSecValid) return;

  try {
    const { userId } = await auth();
    if (!userId) return;

    const clerkUser = await currentUser();
    if (!clerkUser) return;

    const email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      null;

    const name =
      clerkUser.fullName ??
      ([clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || null);

    await prisma.user.upsert({
      where: {
        clerkId: userId,
      },
      create: {
        clerkId: userId,
        email,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        name,
        imageUrl: clerkUser.imageUrl,
      },
      update: {
        email,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        name,
        imageUrl: clerkUser.imageUrl,
      },
    });
  } catch (error) {
    console.error("❌ Error during onboarding user:", error);
  }
}

async function getDevUser() {
  try {
    return await prisma.user.upsert({
      where: { clerkId: "dev-user-local" },
      create: {
        clerkId: "dev-user-local",
        email: "dev@codemytra.local",
        name: "Dev User",
      },
      update: {},
      select: {
        id: true,
        email: true,
        name: true,
        imageUrl: true,
        clerkId: true,
      },
    });
  } catch (dbErr) {
    console.error("❌ Error resolving dev auth user:", dbErr);
    return null;
  }
}

export type AuthSessionState =
  | {
      status: "authenticated";
      user: {
        id: string;
        email: string | null;
        name: string | null;
        imageUrl: string | null;
        clerkId: string;
      };
    }
  | { status: "unauthenticated" }
  | { status: "unconfigured"; reason: string };

/**
 * Distinguishes clearly between:
 * 1. An authenticated session
 * 2. A truly unauthenticated visitor
 * 3. An unconfigured or invalid Clerk credential state
 */
export async function getAuthSessionState(): Promise<AuthSessionState> {
  // Explicit insecure dev auth allowed in non-production environments
  if (
    process.env.ALLOW_INSECURE_DEV_AUTH === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    const devUser = await getDevUser();
    if (devUser) {
      return { status: "authenticated", user: devUser };
    }
  }

  const isPubValid = isClerkPublishableKeyValid(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const isSecValid = isClerkSecretKeyValid(process.env.CLERK_SECRET_KEY);

  if (!isPubValid || !isSecValid) {
    const hasAnyKey = Boolean(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_SECRET_KEY
    );
    return {
      status: "unconfigured",
      reason: hasAnyKey
        ? "Clerk publishable key or secret key is invalid"
        : "Clerk credentials not configured in environment",
    };
  }

  try {
    const user = await currentUser();

    if (!user) {
      return { status: "unauthenticated" };
    }

    let dbUser = await prisma.user.findUnique({
      where: {
        clerkId: user.id,
      },
      select: {
        id: true,
        email: true,
        name: true,
        imageUrl: true,
        clerkId: true,
      },
    });

    if (!dbUser) {
      await onBoardUser();
      dbUser = await prisma.user.findUnique({
        where: {
          clerkId: user.id,
        },
        select: {
          id: true,
          email: true,
          name: true,
          imageUrl: true,
          clerkId: true,
        },
      });
    }

    if (!dbUser) {
      return { status: "unauthenticated" };
    }

    return { status: "authenticated", user: dbUser };
  } catch (error) {
    console.error("❌ Error fetching current user:", error);
    return { status: "unauthenticated" };
  }
}

export const getCurrentUser = async () => {
  const session = await getAuthSessionState();
  if (session.status === "authenticated") {
    return session.user;
  }
  return null;
};