"use client";

import { useState, type FormEvent } from "react";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("Early access");
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState(
    "Prototype only: the button prepares a copyable message. It does not transmit your details."
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const txt = `CodeMytra enquiry\nName: ${name}\nEmail: ${email}\nTopic: ${subject}\nMessage: ${message}`;
    try {
      await navigator.clipboard.writeText(txt);
      setFeedback(
        "Message copied. No information was sent; paste into your preferred communication channel."
      );
    } catch {
      setFeedback("Clipboard unavailable. Please manually copy your message.");
    }
  };

  return (
    <form className="form" id="contactForm" onSubmit={handleSubmit}>
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
      </div>
      <button className="btn" type="submit">
        Prepare message ↗
      </button>
      <div
        id="formMessage"
        className="muted"
        aria-live="polite"
        style={{ fontSize: "12px" }}
      >
        {feedback}
      </div>
    </form>
  );
}
