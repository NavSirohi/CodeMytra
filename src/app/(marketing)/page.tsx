import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Build something meaningful | CodeMytra",
  description:
    "Describe a business website or software idea. CodeMytra helps plan, design and generate application code.",
};

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="reveal">
            <span className="eyebrow">A building partner for every idea</span>
            <h1>
              Your idea.<br />
              A thoughtful way <i>to build it.</i>
            </h1>
            <p className="lede">
              From a neighbourhood business finding its first home online to a developer building their next product, CodeMytra helps turn a conversation into a workable web application.
            </p>
            <div className="actions">
              <Link className="btn" href="/builder">
                Start with your idea <span aria-hidden="true">↗</span>
              </Link>
              <Link className="btn alt" href="/sign-in">
                Sign In / Sign Up
              </Link>
              <Link className="btn alt" href="/how-it-works">
                See how it works <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <p className="micro">
              Plan the experience · Generate code · Preview and refine · Export your project
            </p>
          </div>
          <div className="reveal">
            <div
              className="demo float"
              aria-label="Illustrative preview of CodeMytra builder"
            >
              <div className="topbar">
                <i className="dot" />
                <i className="dot" />
                <i className="dot" />
                <span
                  style={{
                    fontSize: "11px",
                    color: "#617066",
                    marginLeft: "10px",
                  }}
                >
                  CodeMytra / Project workspace · Sample interface
                </span>
              </div>
              <div className="mock">
                <div className="side">
                  <strong>◧ My workspace</strong>
                  <div className="sel">▦ Preview</div>
                  <div>⌘ Code files</div>
                  <div>◷ Revisions</div>
                  <div>◇ Agent activity</div>
                  <div>⇩ Export</div>
                </div>
                <div className="canvas">
                  <div className="project-title">
                    <strong>Sukoon Studio</strong>
                    <span className="tag">Example project</span>
                  </div>
                  <div className="preview">
                    <small>THE SPACE TO SLOW DOWN</small>
                    <h4>Come back to yourself.</h4>
                    <p
                      style={{
                        fontSize: "11px",
                        maxWidth: "180px",
                        color: "#6e6559",
                      }}
                    >
                      Restorative wellness for everyday living.
                    </p>
                    <span
                      style={{
                        display: "inline-block",
                        background: "#784733",
                        color: "white",
                        padding: "9px 13px",
                        borderRadius: "4px",
                        fontSize: "10px",
                      }}
                    >
                      Explore services →
                    </span>
                    <div className="shape" />
                  </div>
                  <p style={{ fontSize: "11px", color: "#748074" }}>
                    Illustrative product preview. Not an active generated site.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section cream">
        <div className="wrap">
          <div className="head reveal">
            <span className="eyebrow">Built around your goal</span>
            <h2>
              One platform. Two ways <i>to begin.</i>
            </h2>
            <p className="muted">
              You don&apos;t need to think like an engineer to start. And if you are one, your code remains inspectable and yours to take further.
            </p>
          </div>
          <div className="cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div className="card reveal">
              <span className="num">01</span>
              <h3>I&apos;m running a business</h3>
              <p>
                Describe what you sell, the customers you serve, and how they should reach you. Start with a service site, portfolio or enquiry experience and shape the details together.
              </p>
              <Link className="btn alt" href="/product#business">
                Explore business use cases <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <div className="card reveal">
              <span className="num">02</span>
              <h3>I&apos;m building software</h3>
              <p>
                Define pages, application behaviour and data requirements. Follow the generation process, inspect source files, iterate and export the project for further development.
              </p>
              <Link className="btn alt" href="/product#developers">
                Explore developer tools <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap split">
          <div className="reveal">
            <span className="eyebrow">A different kind of builder</span>
            <h2>
              Not just an answer. <i>A process you can follow.</i>
            </h2>
            <p className="muted">
              CodeMytra is designed around specialised AI agents that turn your brief into an organised plan, propose the design, generate application components and check the result. You remain part of the decisions.
            </p>
            <Link className="btn alt" href="/how-it-works">
              Discover our process <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <div className="reveal">
            <div className="step">
              <span className="num">1</span>
              <div>
                <strong>Understand your intent</strong>
                <p>Clarify purpose, audience, style and must-have functionality.</p>
              </div>
            </div>
            <div className="step">
              <span className="num">2</span>
              <div>
                <strong>Plan before building</strong>
                <p>Review an outline and architecture instead of guessing what the AI will make.</p>
              </div>
            </div>
            <div className="step">
              <span className="num">3</span>
              <div>
                <strong>Build with coordinated agents</strong>
                <p>Design, application structure and implementation work together.</p>
              </div>
            </div>
            <div className="step">
              <span className="num">4</span>
              <div>
                <strong>Inspect, refine and own the result</strong>
                <p>Preview your work, request changes, track revisions and export the code.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section dark">
        <div className="wrap split">
          <div className="reveal">
            <span className="eyebrow">Your workspace</span>
            <h2>
              The work is visible. <i>The control stays with you.</i>
            </h2>
            <p className="muted">
              A workspace for conversation, progress, preview and files. Temporary previews are for testing; production publishing of generated sites is planned for a later release.
            </p>
            <div className="actions">
              <Link className="btn alt" href="/product">
                Explore the product <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>
          <div
            className="reveal"
            style={{
              border: "1px solid #496051",
              borderRadius: "12px",
              padding: "25px",
              background: "#23362a",
            }}
          >
            <p style={{ fontSize: "12px", color: "#abc4aa" }}>
              PROJECT HEALTH / ILLUSTRATIVE UI
            </p>
            <h3>More than a picture of a website.</h3>
            <div className="step">
              <span>✓</span>
              <div>
                <strong>Project brief</strong>
                <p style={{ color: "#b6c6b9" }}>What should this product do?</p>
              </div>
            </div>
            <div className="step">
              <span>✓</span>
              <div>
                <strong>Design direction</strong>
                <p style={{ color: "#b6c6b9" }}>How should it look and feel?</p>
              </div>
            </div>
            <div className="step">
              <span>✓</span>
              <div>
                <strong>Source + revisions</strong>
                <p style={{ color: "#b6c6b9" }}>What changed and what can be exported?</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap split reveal">
          <div>
            <span className="eyebrow">An invitation</span>
            <h2>
              Start with an idea, <i>not a specification.</i>
            </h2>
            <p className="muted">
              Try the guided builder concept, or explore how we&apos;re shaping a useful tool for business owners and independent developers.
            </p>
            <div className="actions">
              <Link className="btn" href="/builder">
                Open the builder preview <span aria-hidden="true">↗</span>
              </Link>
              <Link className="btn alt" href="/pricing">
                View pricing plans <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>
          <div className="card">
            <strong>For example, tell us:</strong>
            <p>
              “I run a small bakery. I need a warm website with a menu, custom cake enquiry form and opening hours.”
            </p>
            <hr style={{ border: 0, borderTop: "1px solid var(--line)" }} />
            <p>
              “I&apos;m developing a lightweight project tracker with authentication, tasks, filters and a database.”
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
