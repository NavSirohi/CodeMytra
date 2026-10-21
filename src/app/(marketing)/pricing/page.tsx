import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing | CodeMytra",
  description: "CodeMytra early-access pricing and product scope",
};

export default function PricingPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">Simple, transparent plans</span>
        <h1>
          Begin with an idea. <i>Choose more when you need it.</i>
        </h1>
        <p className="lede">
          CodeMytra is in development. These are proposed plan structures, not active subscription offers. Final prices and credit limits will be confirmed before billing launches.
        </p>
      </div>

      <section className="section cream">
        <div className="wrap">
          <div className="notice" style={{ marginBottom: "26px" }}>
            Pre-launch notice: checkout is not active. We do not currently accept payments through this design prototype.
          </div>
          <div className="cards">
            <div className="card">
              <span className="eyebrow">Explore</span>
              <h3>Free</h3>
              <div className="price">₹0</div>
              <p>For seeing what the builder can do.</p>
              <ul className="list">
                <li>Limited generation allowance (TBD)</li>
                <li>Guided project brief</li>
                <li>Temporary previews</li>
                <li>Inspect project files</li>
              </ul>
              <Link className="btn alt" href="/builder">
                Explore the builder <span aria-hidden="true">↗</span>
              </Link>
            </div>

            <div className="card" style={{ border: "2px solid var(--green)" }}>
              <span className="eyebrow">Planned</span>
              <h3>Maker</h3>
              <div className="price">TBD</div>
              <p>For individuals building more frequently.</p>
              <ul className="list">
                <li>More generation allowance</li>
                <li>Multi-step project revisions</li>
                <li>Source ZIP export</li>
                <li>Priority generation limits to be confirmed</li>
              </ul>
              <Link className="btn" href="/contact">
                Ask about early access <span aria-hidden="true">↗</span>
              </Link>
            </div>

            <div className="card">
              <span className="eyebrow">Future</span>
              <h3>Team</h3>
              <div className="price">TBD</div>
              <p>For small teams coordinating projects.</p>
              <ul className="list">
                <li>Shared project access (planned)</li>
                <li>Team usage visibility (planned)</li>
                <li>Member roles (planned)</li>
                <li>Priority support (planned)</li>
              </ul>
              <Link className="btn alt" href="/contact">
                Contact the team <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap faq">
          <div className="head">
            <span className="eyebrow">Before you begin</span>
            <h2>
              Frequently asked <i>questions.</i>
            </h2>
          </div>
          <details>
            <summary>Can I publish the websites I generate?</summary>
            <p>
              Not through CodeMytra in the MVP. Users can preview projects temporarily; one-click deployment is a future feature.
            </p>
          </details>
          <details>
            <summary>Will CodeMytra provide source code?</summary>
            <p>
              Source visibility and project export are included in the planned MVP scope. The live integration must be completed and tested before launch.
            </p>
          </details>
          <details>
            <summary>What is a generation credit?</summary>
            <p>
              It is a planned usage unit for generation activity. Specific allowances and metering will be published before paid subscriptions are enabled.
            </p>
          </details>
          <details>
            <summary>Are paid plans active?</summary>
            <p>
              No. This is a pre-launch design preview, and no checkout or billing is connected.
            </p>
          </details>
          <details>
            <summary>Can developers bring their own model?</summary>
            <p>
              Self-hosted and bring-your-own-model options are an architectural direction for a later release, not an active feature.
            </p>
          </details>
        </div>
      </section>
    </main>
  );
}
