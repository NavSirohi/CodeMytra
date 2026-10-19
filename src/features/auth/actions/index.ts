"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";


export async function onBoardUser() {
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
        }
    })
}

export const getCurrentUser = async () => {
    // When explicit insecure dev auth is enabled in non-production, provide the local dev user
    if (process.env.ALLOW_INSECURE_DEV_AUTH === "true" && process.env.NODE_ENV !== "production") {
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

    try {
      const user = await currentUser();
  
      if (!user) {
        return null;
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
  
      return dbUser;
    } catch (error) {
      console.error("❌ Error fetching current user:", error);
      return null;
    }
  };
  