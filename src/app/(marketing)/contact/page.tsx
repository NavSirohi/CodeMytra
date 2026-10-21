import type { Metadata } from "next";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: "Contact | CodeMytra",
  description:
    "Contact the CodeMytra project team for feedback, early access and partnership interest",
};

export default function ContactPage() {
  return (
    <main>
      <div className="wrap pagehead">
        <span className="eyebrow">Let&apos;s talk</span>
        <h1>
          Have an idea, question or <i>something to share?</i>
        </h1>
        <p className="lede">
          We&apos;d love to hear how you&apos;re thinking about using CodeMytra—whether you&apos;re running a business, building software or exploring the product.
        </p>
      </div>

      <section className="section cream">
        <div className="wrap split">
          <div>
            <h2>
              Tell us what <i>you&apos;re building.</i>
            </h2>
            <p className="muted">
              Use this form to share your feedback or questions. When backend storage is active, messages are saved securely for our team; if unconfigured, your message is preserved for direct copy.
            </p>
            <div className="card">
              <strong>Good reasons to reach out</strong>
              <ul className="list">
                <li>Share feedback on the product direction</li>
                <li>Ask about early access</li>
                <li>Discuss a small-business use case</li>
                <li>Suggest developer workflow improvements</li>
                <li>Ask about the team or project</li>
              </ul>
            </div>
          </div>
          <ContactForm />
        </div>
      </section>
    </main>
  );
}
