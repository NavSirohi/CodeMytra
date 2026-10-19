import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About and Team | CodeMytra",
  description:
    "Building tools that feel like a good teammate. Learn about CodeMytra's purpose and principles.",
};

export default function AboutPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">About CodeMytra</span>
        <h1>
          Building tools that feel <i>like a good teammate.</i>
        </h1>
        <p className="lede">
          Mytra takes its inspiration from Mitra—friend. The idea behind CodeMytra is simple: software creation should feel collaborative, understandable and accessible.
        </p>
      </div>

      <section className="section cream">
        <div className="wrap split">
          <div>
            <span className="eyebrow">Our purpose</span>
            <h2>
              Good ideas should not stop at <i>technical barriers.</i>
            </h2>
            <p className="muted">
              Small businesses have real needs but may not have access to a design and engineering team. Independent developers have the skills but not always the time to build everything from scratch.
            </p>
            <p className="muted">
              We&apos;re shaping CodeMytra to be useful to both: friendly at the beginning, transparent as the work grows more complex, and respectful of the user&apos;s ownership of their project.
            </p>
          </div>
          <div className="card">
            <h3>Principles we build by</h3>
            <div className="step">
              <span className="num">01</span>
              <div>
                <strong>Clarity over jargon</strong>
                <p>Explain the outcome before describing the infrastructure.</p>
              </div>
            </div>
            <div className="step">
              <span className="num">02</span>
              <div>
                <strong>Useful over flashy</strong>
                <p>The product should serve real tasks, not just produce a visual demo.</p>
              </div>
            </div>
            <div className="step">
              <span className="num">03</span>
              <div>
                <strong>Visible work</strong>
                <p>Help users understand the plan, progress and generated result.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">The people behind it</span>
            <h2>
              Built with curiosity. <i>Developed with care.</i>
            </h2>
            <p className="muted">
              CodeMytra is an evolving independent project built on an existing educational starter implementation and extended toward a multi-agent application builder.
            </p>
          </div>
          <div className="card" style={{ maxWidth: "750px" }}>
            <span className="num">म</span>
            <h3>Meet the project team</h3>
            <p>
              We&apos;re preparing verified team profiles, responsibilities and contributor credits for publication. We won&apos;t invent team members or achievements to fill this page.
            </p>
            <p className="muted">
              The development documentation will distinguish the original educational implementation from new CodeMytra contributions.
            </p>
            <Link className="btn alt" href="/contact">
              Get in touch <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
