"use client";

import { useState, type FormEvent } from "react";
import { submitContactMessage } from "@/features/contact/actions";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("Early access");
  const [message, setMessage] = useState("");
  const [botField, setBotField] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);
    setFieldErrors({});

    try {
      const result = await submitContactMessage({
        name,
        email,
        subject,
        message,
        botField,
      });

      if (result.success) {
        setFeedback(result.message);
        setName("");
        setEmail("");
        setMessage("");
      } else if (result.fallbackToClipboard) {
        const txt = `CodeMytra enquiry\nName: ${name}\nEmail: ${email}\nTopic: ${subject}\nMessage: ${message}`;
        try {
          await navigator.clipboard.writeText(txt);
        } catch {
          // ignore clipboard errors
        }
        setFeedback(result.message);
      } else {
        setFeedback(result.message);
        if (result.errors) {
          setFieldErrors(result.errors);
        }
      }
    } catch {
      // Network or runtime fallback
      const txt = `CodeMytra enquiry\nName: ${name}\nEmail: ${email}\nTopic: ${subject}\nMessage: ${message}`;
      try {
        await navigator.clipboard.writeText(txt);
        setFeedback(
          "Storage is currently unconfigured. Your message has been copied to your clipboard so you can send it directly."
        );
      } catch {
        setFeedback(
          "Submission failed and clipboard was unavailable. Please manually copy your message."
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="form" id="contactForm" onSubmit={handleSubmit}>
      {/* Honeypot field for bot protection */}
      <div style={{ display: "none" }} aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={botField}
          onChange={(e) => setBotField(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="name">Your name</label>
        <input
          required
          id="name"
          maxLength={100}
          autoComplete="name"
          placeholder="How should we address you?"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {fieldErrors.name && (
          <p className="notice" style={{ color: "#e5484d", fontSize: "12px", marginTop: "4px" }}>
            {fieldErrors.name}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="email">Email address</label>
        <input
          required
          type="email"
          id="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {fieldErrors.email && (
          <p className="notice" style={{ color: "#e5484d", fontSize: "12px", marginTop: "4px" }}>
            {fieldErrors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="subject">What can we help with?</label>
        <select
          id="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        >
          <option>Early access</option>
          <option>Business use case</option>
          <option>Developer feedback</option>
          <option>Partnership</option>
          <option>Something else</option>
        </select>
        {fieldErrors.subject && (
          <p className="notice" style={{ color: "#e5484d", fontSize: "12px", marginTop: "4px" }}>
            {fieldErrors.subject}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="message">Your message</label>
        <textarea
          id="message"
          required
          maxLength={4000}
          placeholder="Tell us a little about your idea or question..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        {fieldErrors.message && (
          <p className="notice" style={{ color: "#e5484d", fontSize: "12px", marginTop: "4px" }}>
            {fieldErrors.message}
          </p>
        )}
      </div>

      <button className="btn orange" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Sending message..." : "Send message ↗"}
      </button>

      {feedback && (
        <div
          id="formMessage"
          className="muted"
          aria-live="polite"
          style={{ fontSize: "12px", marginTop: "8px" }}
        >
          {feedback}
        </div>
      )}
    </form>
  );
}
