import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest, type NextFetchEvent, type NextMiddleware } from 'next/server'
import { isClerkPublishableKeyValid, isClerkSecretKeyValid } from '@/lib/auth-keys'

export const isPublicRoute = createRouteMatcher([
  '/',
  '/product(.*)',
  '/how-it-works(.*)',
  '/pricing(.*)',
  '/about(.*)',
  '/contact(.*)',
  '/builder(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/inngest(.*)',
])

export interface AuthRoutingEnvironment {
  clerkPublishableKey?: string;
  clerkSecretKey?: string;
  nodeEnv?: string;
  allowInsecureDevAuth?: string;
}

export function evaluateAuthRouting(
  req: NextRequest,
  env: AuthRoutingEnvironment = {
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    clerkSecretKey: process.env.CLERK_SECRET_KEY,
    nodeEnv: process.env.NODE_ENV,
    allowInsecureDevAuth: process.env.ALLOW_INSECURE_DEV_AUTH,
  }
): { action: "public" | "delegate_to_clerk" | "allow_dev_insecure" | "fail_closed"; response?: NextResponse } {
  // Inngest background functions and discovery endpoints are strictly isolated from Clerk
  if (req.nextUrl.pathname.startsWith("/api/inngest")) {
    return { action: "public", response: NextResponse.next() };
  }

  const isClerkConfigured =
    isClerkPublishableKeyValid(env.clerkPublishableKey) &&
    isClerkSecretKeyValid(env.clerkSecretKey);

  if (isClerkConfigured) {
    return { action: "delegate_to_clerk" };
  }

  // If Clerk keys are missing or invalid:
  if (isPublicRoute(req)) {
    return { action: "public", response: NextResponse.next() };
  }

  const isExplicitDevAuthAllowed =
    env.nodeEnv !== "production" && env.allowInsecureDevAuth === "true";

  if (isExplicitDevAuthAllowed) {
    return { action: "allow_dev_insecure", response: NextResponse.next() };
  }

  // Fail closed in production or whenever explicit dev auth is not granted
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const isInvalid = Boolean(env.clerkPublishableKey || env.clerkSecretKey);
    return {
      action: "fail_closed",
      response: NextResponse.json(
        {
          error: isInvalid
            ? "Authentication credentials invalid"
            : "Authentication service unconfigured",
        },
        { status: isInvalid ? 503 : 401 }
      ),
    };
  }

  const signInUrl = new URL("/sign-in", req.url);
  signInUrl.searchParams.set("redirect_url", req.nextUrl.pathname);
  return {
    action: "fail_closed",
    response: NextResponse.redirect(signInUrl),
  };
}

let cachedClerkHandler: NextMiddleware | null = null;

function getClerkHandler(): NextMiddleware {
  if (!cachedClerkHandler) {
    cachedClerkHandler = clerkMiddleware(
      async (auth, request) => {
        if (!isPublicRoute(request)) {
          await auth.protect();
        }
      },
      {
        signInUrl: "/sign-in",
        signUpUrl: "/sign-in",
      }
    );
  }
  return cachedClerkHandler;
}

export async function proxy(req: NextRequest, evt: NextFetchEvent) {
  const result = evaluateAuthRouting(req);

  if (result.action !== "delegate_to_clerk") {
    return result.response!;
  }

  const handler = getClerkHandler();
  return handler(req, evt);
}

export default proxy;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
    // Always run for Clerk-specific frontend API routes
    '/__clerk/(.*)',
  ],
}