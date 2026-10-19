import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server'

const isPublicRoute = createRouteMatcher([
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

export default function middleware(req: NextRequest, evt: NextFetchEvent) {
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
    !process.env.CLERK_SECRET_KEY
  ) {
    return NextResponse.next();
  }

  return clerkMiddleware(async (auth, request) => {
    if (!isPublicRoute(request)) {
      await auth.protect();
    }
  })(req, evt);
}

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