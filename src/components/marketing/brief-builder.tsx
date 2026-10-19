"use client";

import Link from "next/link";
import { useState } from "react";

const EXAMPLES = [
  {
    label: "Local bakery",
    prompt:
      "Build a website for my neighbourhood bakery with menu, opening hours, custom cake enquiry and a warm visual style.",
  },
  {
    label: "Portfolio",
    prompt:
      "Build a portfolio for an independent designer with project case studies and a contact section.",
  },
  {
    label: "Developer app",
    prompt:
      "Build a simple task management web app with project lists, authentication and a database.",
  },
];

const STYLES = [
  "Calm & editorial",
  "Bold & modern",
  "Warm & friendly",
  "Minimal & technical",
];

export function BriefBuilder() {
  const [selectedExample, setSelectedExample] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState("Calm & editorial");
  const [idea, setIdea] = useState("");
  const [brief, setBrief] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("Copy brief");

  const handleSelectExample = (ex: (typeof EXAMPLES)[number]) => {
    setSelectedExample(ex.label);
    setIdea(ex.prompt);
  };

  const handleCreateBrief = () => {
    const trimmed = idea.trim();
    if (!trimmed) {
      document.getElementById("idea")?.focus();
      return;
    }

    const briefText = `CodeMytra project brief\nGoal: ${trimmed}\nStyle: ${selectedStyle}\nNext steps: requirements clarification, plan approval, design and architecture, implementation, integration and validation.\nStatus: Design prototype; no generation started.`;
    setBrief(briefText);
    setCopyStatus("Copy brief");
  };

  const handleCopy = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief);
      setCopyStatus("Copied ✓");
    } catch {
      setCopyStatus("Copy unavailable");
    }
  };

  return (
    <div className="builder">
      <aside className="builderaside">
        <span className="eyebrow">Your project</span>
        <h3>Let&apos;s get specific.</h3>
        <p className="muted" style={{ fontSize: "13px" }}>
          A little context helps us create a more relevant plan.
        </p>
        <div className="step">
          <span className="num">1</span>
          <div>
            <strong>Project type</strong>
            <p>Who is it for?</p>
          </div>
        </div>
        <div className="step">
          <span className="num">2</span>
          <div>
            <strong>Visual direction</strong>
            <p>How should it feel?</p>
          </div>
        </div>
        <div className="step">
          <span className="num">3</span>
          <div>
            <strong>Brief</strong>
            <p>What should it do?</p>
          </div>
        </div>
        <p className="notice">Design preview. No data is sent or stored.</p>
      </aside>

      <div className="buildermain">
        <div className="prompt">
          <p className="mini-label">01 / Choose an example or start fresh</p>
          <div className="options" id="examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className={selectedExample === ex.label ? "chosen" : ""}
                onClick={() => handleSelectExample(ex)}
              >
                {ex.label}
              </button>
            ))}
          </div>

          <p className="mini-label">02 / What is your visual style?</p>
          <div className="options" id="styles">
            {STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className={selectedStyle === style ? "chosen" : ""}
                onClick={() => setSelectedStyle(style)}
              >
                {style}
              </button>
            ))}
          </div>

          <label htmlFor="idea" className="mini-label">
            03 / Describe your project
          </label>
          <textarea
            id="idea"
            placeholder="I want to build..."
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
          />

          <div className="actions">
            <button
              className="btn orange"
              id="makeBrief"
              type="button"
              onClick={handleCreateBrief}
            >
              Create project brief →
            </button>
            <Link href="/how-it-works" className="btn alt">
              Learn the process
            </Link>
          </div>
        </div>

        {brief && (
          <div id="brief" aria-live="polite" style={{ margin: "20px 0" }}>
            <div className="card">
              <h3>Your starting brief</h3>
              <p style={{ whiteSpace: "pre-line" }}>{brief}</p>
              <button className="btn" type="button" onClick={handleCopy}>
                {copyStatus}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
