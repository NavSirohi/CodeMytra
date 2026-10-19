import Link from "next/link";

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footgrid">
          <div>
            <Link href="/" className="brand">
              <span className="mark">म</span>Code<em>Mytra</em>
            </Link>
            <p style={{ maxWidth: "280px", color: "#c1c9bd", fontSize: "13px" }}>
              Your ideas deserve a thoughtful building partner. Made with a belief that good software should be within everyone&apos;s reach.
            </p>
          </div>
          <div>
            <strong>Product</strong>
            <Link href="/product">Features</Link>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/builder">Builder preview</Link>
          </div>
          <div>
            <strong>Company</strong>
            <Link href="/about">About &amp; team</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div>
            <strong>Currently</strong>
            <Link href="/pricing">Early access plans</Link>
            <Link href="/product#preview">Preview-only MVP</Link>
            <Link href="/contact">Share feedback</Link>
          </div>
        </div>
        <div className="bottom">
          <span>© 2026 CodeMytra. Product concept / pre-launch preview.</span>
          <span>Generated applications are not published in the current MVP.</span>
        </div>
      </div>
    </footer>
  );
}
