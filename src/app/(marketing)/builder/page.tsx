import type { Metadata } from "next";
import { BriefBuilder } from "@/components/marketing/brief-builder";

export const metadata: Metadata = {
  title: "Builder Preview | CodeMytra",
  description:
    "Explore the CodeMytra guided brief and builder interface concept",
};

export default function BuilderPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">Product interaction preview</span>
        <h1>
          Tell us about <i>your idea.</i>
        </h1>
        <p className="lede">
          This interactive brief demonstrates the proposed CodeMytra onboarding. It creates a structured local summary you can copy; AI generation is not connected in this static design.
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
