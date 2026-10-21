import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How it works | CodeMytra",
  description:
    "A team of specialists, guided by your idea. How CodeMytra coordinates planning, design, implementation and verification.",
};

export default function HowItWorksPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">How it works</span>
        <h1>
          A team of specialists, <i>guided by your idea.</i>
        </h1>
        <p className="lede">
          You describe the outcome. CodeMytra&apos;s planned coordinated AI workflow breaks the work into decisions and manageable stages, with review points before implementation.
        </p>
      </div>

      <section className="section cream">
        <div className="wrap">
          <div className="diagram reveal">
            <span>Your idea</span>
            <b>→</b>
            <span>Clarify</span>
            <b>→</b>
            <span>Approve plan</span>
            <b>→</b>
            <span>Design + architecture</span>
            <b>→</b>
            <span>Build</span>
            <b>→</b>
            <span>Review</span>
            <b>→</b>
            <span>Preview</span>
          </div>
          <div className="cards" style={{ marginTop: "35px" }}>
            <div className="card reveal">
              <span className="num">01</span>
              <h3>Tell us what matters</h3>
              <p>
                A guided conversation clarifies your audience, business goals, functionality and preferred visual direction.
              </p>
            </div>
            <div className="card reveal">
              <span className="num">02</span>
              <h3>Agree on the plan</h3>
              <p>
                The planning agent prepares a requirements outline for review before generation.
              </p>
            </div>
            <div className="card reveal">
              <span className="num">03</span>
              <h3>Shape the experience</h3>
              <p>
                Design and architecture agents define the layout, interactions, components and application structure.
              </p>
            </div>
            <div className="card reveal">
              <span className="num">04</span>
              <h3>Build the pieces</h3>
              <p>
                Specialised implementation stages tackle interface, application logic and data requirements.
              </p>
            </div>
            <div className="card reveal">
              <span className="num">05</span>
              <h3>Bring it together</h3>
              <p>
                Integration and QA stages check that the pieces work together, within the supported project template.
              </p>
            </div>
            <div className="card reveal">
              <span className="num">06</span>
              <h3>Preview and refine</h3>
              <p>
                Explore a temporary preview, inspect files, request changes, preserve revisions and export source.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap split">
          <div>
            <span className="eyebrow">Why multiple agents?</span>
            <h2>
              Different responsibilities. <i>One shared direction.</i>
            </h2>
            <p className="muted">
              A design task and a database task need different considerations. Instead of treating one large response as the product, CodeMytra is being designed to coordinate specialised work through a shared, structured project plan.
            </p>
            <p className="muted">
              Progress should show what stage is running, what completed and where human approval is needed. It&apos;s not just a decorative loading animation.
            </p>
          </div>
          <div className="card">
            <h3>What you stay in control of</h3>
            <ul className="list">
              <li>The initial brief and visual direction</li>
              <li>Approval before implementation</li>
              <li>Follow-up instructions and changes</li>
              <li>Inspection of generated code</li>
              <li>Project revisions and source export</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section dark">
        <div className="wrap">
          <span className="eyebrow">Where things run</span>
          <h2>
            We take care of the workspace <i>while you focus on the idea.</i>
          </h2>
          <p className="muted" style={{ maxWidth: "740px" }}>
            Generated applications are run in temporary, isolated environments for preview and testing. Your project source is designed to be stored separately so it can be restored later. No permanent customer-site hosting is included in this release.
          </p>
          <Link className="btn alt" href="/product">
            See product scope <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
