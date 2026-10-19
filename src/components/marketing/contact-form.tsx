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
  const [selectableMessage, setSelectableMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const formatEnquiry = (n: string, e: string, s: string, m: string) =>
    `CodeMytra enquiry\nName: ${n}\nEmail: ${e}\nTopic: ${s}\nMessage: ${m}`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);
    setSelectableMessage(null);
    setFieldErrors({});

    const formatted = formatEnquiry(name, email, subject, message);

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
        setSelectableMessage(null);
      } else if (result.fallbackToClipboard) {
        // Form values are preserved
        let copied = false;
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(formatted);
            copied = true;
          }
        } catch {
          copied = false;
        }

        if (copied) {
          setFeedback(`Copied to clipboard. ${result.message}`);
          setSelectableMessage(null);
        } else {
          setFeedback(
            "Live storage is unconfigured and automatic clipboard copying was blocked. Please select and copy your formatted message below:"
          );
          setSelectableMessage(formatted);
        }
      } else {
        // Failure or rate limited: preserve form values, do not say "Message received"
        setFeedback(result.message);
        if (result.errors) {
          setFieldErrors(result.errors);
        }
      }
    } catch {
      // Runtime or network failure: preserve form values, honest feedback
      let copied = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(formatted);
          copied = true;
        }
      } catch {
        copied = false;
      }

      if (copied) {
        setFeedback(
          "Copied to clipboard. Live storage is currently unconfigured; please send your message via your preferred channel."
        );
        setSelectableMessage(null);
      } else {
        setFeedback(
          "Live storage is currently unconfigured and automatic clipboard copying was blocked. Please select and copy your message below to send it directly:"
        );
        setSelectableMessage(formatted);
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

      {selectableMessage && (
        <div className="card" style={{ marginTop: "12px" }}>
          <label
            htmlFor="copyableText"
            className="mini-label"
            style={{ display: "block", marginBottom: "6px", fontSize: "11px" }}
          >
            Formatted message (click to select all):
          </label>
          <textarea
            id="copyableText"
            readOnly
            rows={5}
            value={selectableMessage}
            onClick={(e) => e.currentTarget.select()}
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "12px",
              padding: "8px",
              borderRadius: "4px",
              border: "1px solid var(--border)",
              background: "var(--input-bg, #1a1a1a)",
              color: "inherit",
              resize: "vertical",
            }}
          />
        </div>
      )}
    </form>
  );
}
