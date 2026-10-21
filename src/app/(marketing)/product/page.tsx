import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The Product | CodeMytra",
  description:
    "From a simple thought to a structured project. Explore CodeMytra for business owners and independent developers.",
};

export default function ProductPage() {
  return (
    <main>
      <div className="wrap pagehead reveal">
        <span className="eyebrow">The product</span>
        <h1>
          From a simple thought to a <i>structured project.</i>
        </h1>
        <p className="lede">
          A guided experience to understand what you&apos;re building, design around your audience and turn requirements into code you can inspect and improve.
        </p>
      </div>

      <section className="section cream" id="business">
        <div className="wrap split">
          <div>
            <span className="eyebrow">For business owners</span>
            <h2>
              Make the first impression <i>count.</i>
            </h2>
            <p className="muted">
              Explain your business in everyday language. CodeMytra helps translate your offer into a useful website structure, rather than asking you to know frameworks or design jargon.
            </p>
            <span className="pill">Service websites</span>
            <span className="pill">Portfolios</span>
            <span className="pill">Enquiry forms</span>
            <span className="pill">Appointment concepts</span>
            <p>
              Start with what matters: what customers need to know, what they should do next, and how your business should feel.
            </p>
            <Link className="btn" href="/builder">
              Start a business brief <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <div className="card">
            <span className="eyebrow">Example brief</span>
            <h3>“I run a neighbourhood café.”</h3>
            <p>
              Help visitors see the menu, opening hours, atmosphere and how to enquire about an event.
            </p>
            <div className="step">
              <span className="num">01</span>
              <div>
                <strong>Business context</strong>
                <p>Audience, location, goal and key information</p>
              </div>
            </div>
            <div className="step">
              <span className="num">02</span>
              <div>
                <strong>Visual identity</strong>
                <p>Warm editorial photography, typography and tone</p>
              </div>
            </div>
            <div className="step">
              <span className="num">03</span>
              <div>
                <strong>Useful interactions</strong>
                <p>Navigation, forms and clear calls to action</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="developers">
        <div className="wrap split">
          <div className="card">
            <span className="eyebrow">Developer workflow / planned MVP</span>
            <h3>Ideas with structure.</h3>
            <div className="step">
              <span className="num">01</span>
              <div>
                <strong>Requirements document</strong>
                <p>Pages, functionality, data model</p>
              </div>
            </div>
            <div className="step">
              <span className="num">02</span>
              <div>
                <strong>Coordinated implementation</strong>
                <p>Frontend, backend and database tasks</p>
              </div>
            </div>
            <div className="step">
              <span className="num">03</span>
              <div>
                <strong>Validation and revisions</strong>
                <p>Checks, generated source and snapshots</p>
              </div>
            </div>
            <div className="step">
              <span className="num">04</span>
              <div>
                <strong>Portable output</strong>
                <p>ZIP export of the source project</p>
              </div>
            </div>
          </div>
          <div>
            <span className="eyebrow">For independent developers</span>
            <h2>
              Go past the mockup. <i>Understand the build.</i>
            </h2>
            <p className="muted">
              Work from an approved application brief. Follow the agent steps, inspect generated source, request improvements and keep your code accessible.
            </p>
            <p className="muted">
              Backend and database generation are core development goals, not a promise that every requested integration is already supported.
            </p>
            <Link className="btn" href="/how-it-works">
              See the building workflow <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      <section className="section cream" id="preview">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">Preview-first release</span>
            <h2>
              Build and explore now. <i>Publish later.</i>
            </h2>
            <p className="muted">
              CodeMytra itself will be deployed publicly. Websites generated by users are not permanently published in this MVP.
            </p>
          </div>
          <div className="cards">
            <div className="card">
              <span className="num">↗</span>
              <h3>Temporary preview</h3>
              <p>
                Open your application in an isolated testing environment while your workspace is active.
              </p>
            </div>
            <div className="card">
              <span className="num">⌘</span>
              <h3>Editable source</h3>
              <p>
                Review the project structure and request changes in conversation.
              </p>
            </div>
            <div className="card">
              <span className="num">⇩</span>
              <h3>Portable project</h3>
              <p>
                Preserve versions and export the generated source. Managed deployment is a later milestone.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
