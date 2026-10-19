"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { useAuth, UserButton, SignOutButton } from "@clerk/nextjs";
import { isClerkPublishableKeyValid } from "@/lib/auth-keys";

export interface HeaderProps {
  isAuthenticated?: boolean;
}

function ClerkNavControls({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { isSignedIn } = useAuth();

  if (isSignedIn) {
    return (
      <>
        <Link
          href="/dashboard"
          className={pathname === "/dashboard" ? "active" : ""}
          onClick={onNavigate}
        >
          Dashboard
        </Link>
        <Link
          className="btn orange"
          href="/builder"
          onClick={onNavigate}
        >
          Try the builder <span aria-hidden="true">↗</span>
        </Link>
        <div
          className="auth-controls"
          style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}
        >
          <UserButton />
          <SignOutButton>
            <button
              type="button"
              className="btn alt"
              style={{ padding: "8px 14px", fontSize: "12px", cursor: "pointer" }}
              onClick={onNavigate}
            >
              Sign Out
            </button>
          </SignOutButton>
        </div>
      </>
    );
  }

  return (
    <>
      <Link
        href="/sign-in"
        className={pathname === "/sign-in" ? "active" : ""}
        onClick={onNavigate}
      >
        Sign In
      </Link>
      <Link
        className="btn alt"
        href="/sign-in"
        onClick={onNavigate}
        style={{ padding: "8px 14px", fontSize: "12px" }}
      >
        Get Started / Sign Up
      </Link>
      <Link
        className="btn orange"
        href="/builder"
        onClick={onNavigate}
      >
        Try the builder <span aria-hidden="true">↗</span>
      </Link>
    </>
  );
}

export function Header({ isAuthenticated }: HeaderProps = {}) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  const [prevPathname, setPrevPathname] = useState(pathname);

  // Close menu on route change during render
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setIsOpen(false);
  }

  const navLinks = [
    { href: "/", label: "Home", active: pathname === "/" },
    { href: "/product", label: "Product", active: pathname === "/product" },
    { href: "/how-it-works", label: "How it works", active: pathname === "/how-it-works" },
    { href: "/pricing", label: "Pricing", active: pathname === "/pricing" },
    { href: "/about", label: "About", active: pathname === "/about" },
    { href: "/contact", label: "Contact", active: pathname === "/contact" },
  ];

  const hasClerk = isClerkPublishableKeyValid(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  // Fallback navigation blocks for mock/test states
  const signedInNav = (
    <>
      <Link
        href="/dashboard"
        className={pathname === "/dashboard" ? "active" : ""}
        onClick={() => setIsOpen(false)}
      >
        Dashboard
      </Link>
      <Link
        className="btn orange"
        href="/builder"
        onClick={() => setIsOpen(false)}
      >
        Try the builder <span aria-hidden="true">↗</span>
      </Link>
      <div
        className="auth-controls"
        style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}
      >
        <span
          className="user-badge"
          aria-label="User account menu"
          style={{ fontSize: "13px", fontWeight: "600" }}
        >
          Account
        </span>
        <button
          type="button"
          className="btn alt"
          style={{ padding: "8px 14px", fontSize: "12px", cursor: "pointer" }}
          onClick={() => setIsOpen(false)}
        >
          Sign Out
        </button>
      </div>
    </>
  );

  const signedOutNav = (
    <>
      <Link
        href="/sign-in"
        className={pathname === "/sign-in" ? "active" : ""}
        onClick={() => setIsOpen(false)}
      >
        Sign In
      </Link>
      <Link
        className="btn alt"
        href="/sign-in"
        onClick={() => setIsOpen(false)}
        style={{ padding: "8px 14px", fontSize: "12px" }}
      >
        Get Started / Sign Up
      </Link>
      <Link
        className="btn orange"
        href="/builder"
        onClick={() => setIsOpen(false)}
      >
        Try the builder <span aria-hidden="true">↗</span>
      </Link>
    </>
  );

  return (
    <>
      <div className="banner">
        CodeMytra is being developed. Explore the design preview; generation and checkout are not live.
      </div>
      <header className="nav">
        <div className="wrap navinner">
          <Link className="brand" href="/" aria-label="CodeMytra home">
            <span className="mark">म</span>Code<em>Mytra</em>
          </Link>
          <nav
            id="links"
            className={`links ${isOpen ? "open" : ""}`}
            aria-label="Main navigation"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                className={link.active ? "active" : ""}
                href={link.href}
                onClick={() => setIsOpen(false)}
              >
                {link.label}
              </Link>
            ))}

            {isAuthenticated === true ? (
              signedInNav
            ) : isAuthenticated === false ? (
              signedOutNav
            ) : hasClerk ? (
              <ClerkNavControls pathname={pathname} onNavigate={() => setIsOpen(false)} />
            ) : (
              signedOutNav
            )}
          </nav>
          <button
            className="menu"
            id="menu"
            aria-controls="links"
            aria-expanded={isOpen}
            onClick={() => setIsOpen(!isOpen)}
            type="button"
          >
            Menu ☰
          </button>
        </div>
      </header>
    </>
  );
}
