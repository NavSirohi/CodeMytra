"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { isClerkPublishableKeyValid } from "@/lib/auth-keys";

export function HeroActions() {
  const hasClerk = isClerkPublishableKeyValid(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <div className="actions">
      {hasClerk ? <ClerkHeroActions /> : <FallbackHeroActions />}
    </div>
  );
}

function ClerkHeroActions() {
  const { isSignedIn } = useAuth();

  if (isSignedIn) {
    return (
      <>
        <Link className="btn" href="/builder">
          Try the builder <span aria-hidden="true">↗</span>
        </Link>
        <Link className="btn alt" href="/dashboard">
          Go to Dashboard <span aria-hidden="true">↗</span>
        </Link>
        <Link className="btn alt" href="/how-it-works">
          See how it works <span aria-hidden="true">↗</span>
        </Link>
      </>
    );
  }

  return (
    <>
      <Link className="btn" href="/builder">
        Start with your idea <span aria-hidden="true">↗</span>
      </Link>
      <Link className="btn alt" href="/sign-in">
        Sign In / Sign Up
      </Link>
      <Link className="btn alt" href="/how-it-works">
        See how it works <span aria-hidden="true">↗</span>
      </Link>
    </>
  );
}

function FallbackHeroActions() {
  return (
    <>
      <Link className="btn" href="/builder">
        Start with your idea <span aria-hidden="true">↗</span>
      </Link>
      <Link className="btn alt" href="/how-it-works">
        See how it works <span aria-hidden="true">↗</span>
      </Link>
    </>
  );
}
