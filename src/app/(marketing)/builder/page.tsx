import type { Metadata } from "next";
import { BriefBuilder } from "@/components/marketing/brief-builder";

export const metadata: Metadata = {
  title: "Builder Preview | CodeMytra",
  description:
    "Explore the CodeMytra guided brief builder and launch your full-stack application",
};

export default function BuilderPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">Project builder & onboarding</span>
        <h1>
          Tell us about <i>your idea.</i>
        </h1>
        <p className="lede">
          Create a structured brief for your project, choose your visual style, and launch full-stack generation with CodeMytra&apos;s multi-agent AI architecture.
        </p>
      </div>

      <section className="section tight">
        <div className="wrap">
          <BriefBuilder />
        </div>
      </section>
    </main>
  );
}
