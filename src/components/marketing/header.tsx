"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export function Header() {
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
            <Link
              className="btn orange"
              href="/builder"
              onClick={() => setIsOpen(false)}
            >
              Try the builder <span aria-hidden="true">↗</span>
            </Link>
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
