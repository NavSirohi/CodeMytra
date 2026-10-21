"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/features/projects/actions";

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

const PENDING_BRIEF_STORAGE_KEY = "codemytra_pending_brief";

function generateSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `brief_${crypto.randomUUID()}`;
  }
  return `brief_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function BriefBuilder() {
  const router = useRouter();
  const [selectedExample, setSelectedExample] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState("Calm & editorial");
  const [idea, setIdea] = useState("");
  const [submissionId, setSubmissionId] = useState<string>(() => generateSubmissionId());
  const [brief, setBrief] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("Copy brief");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Restore brief and idempotency identifier across authentication redirect without duplicate runs
  useEffect(() => {
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const isResume = searchParams.get("resume") === "true";
      const savedRaw = sessionStorage.getItem(PENDING_BRIEF_STORAGE_KEY);

      if (savedRaw) {
        const saved = JSON.parse(savedRaw);
        if (saved && typeof saved.idea === "string") {
          queueMicrotask(() => {
            setIdea(saved.idea);
            if (saved.selectedStyle) setSelectedStyle(saved.selectedStyle);
            if (saved.selectedExample) setSelectedExample(saved.selectedExample);
            if (saved.submissionId) setSubmissionId(saved.submissionId);

            const briefText = `CodeMytra project brief\nGoal: ${saved.idea}\nStyle: ${saved.selectedStyle || "Calm & editorial"}\nNext steps: requirements clarification, plan approval, design and architecture, implementation, integration and validation.`;
            setBrief(briefText);

            if (isResume) {
              // Strip search param from address bar so page refresh does not trigger resume again
              window.history.replaceState({}, document.title, window.location.pathname);

              if (saved.pendingSubmit) {
                // Disarm pendingSubmit immediately to guarantee duplicate runs are impossible
                sessionStorage.setItem(
                  PENDING_BRIEF_STORAGE_KEY,
                  JSON.stringify({ ...saved, pendingSubmit: false })
                );

                setStatusMessage("Authentication verified. Starting project generation...");
                setIsSubmitting(true);

                const fullPrompt = `Goal: ${saved.idea}\nVisual Style: ${saved.selectedStyle || "Calm & editorial"}`;
                createProject(fullPrompt, saved.submissionId)
                  .then((result) => {
                    if ("error" in result && result.error) {
                      setErrorMessage(result.error);
                      setStatusMessage(null);
                      setIsSubmitting(false);
                    } else if ("id" in result && result.id) {
                      sessionStorage.removeItem(PENDING_BRIEF_STORAGE_KEY);
                      router.push(`/projects/${result.id}`);
                    }
                  })
                  .catch((err) => {
                    setErrorMessage(err?.message || "Failed to start generation");
                    setStatusMessage(null);
                    setIsSubmitting(false);
                  });
              } else {
                setStatusMessage("Your project brief has been restored. Ready to build!");
              }
            }
          });
        }
      }
    } catch (e) {
      console.warn("Could not inspect saved brief", e);
    }
  }, [router]);

  // Continuously persist entered prompt in sessionStorage so auth redirect or page navigation never loses input
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (idea.trim()) {
      try {
        const existingRaw = sessionStorage.getItem(PENDING_BRIEF_STORAGE_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        sessionStorage.setItem(
          PENDING_BRIEF_STORAGE_KEY,
          JSON.stringify({
            ...existing,
            idea,
            selectedStyle,
            selectedExample,
            submissionId,
            savedAt: Date.now(),
          })
        );
      } catch {
        // Ignore storage errors in restricted contexts
      }
    }
  }, [idea, selectedStyle, selectedExample, submissionId]);

  const handleSelectExample = (ex: (typeof EXAMPLES)[number]) => {
    setSelectedExample(ex.label);
    setIdea(ex.prompt);
    setErrorMessage(null);
    setSubmissionId(generateSubmissionId());
  };

  const handleCreateBrief = () => {
    const trimmed = idea.trim();
    if (!trimmed) {
      document.getElementById("idea")?.focus();
      setErrorMessage("Please describe your project idea.");
      return;
    }

    setErrorMessage(null);
    const briefText = `CodeMytra project brief\nGoal: ${trimmed}\nStyle: ${selectedStyle}\nNext steps: requirements clarification, plan approval, design and architecture, implementation, integration and validation.`;
    setBrief(briefText);
    setCopyStatus("Copy brief");
  };

  const handleGenerateProject = async () => {
    const trimmed = idea.trim();
    if (!trimmed || trimmed.length < 3) {
      setErrorMessage("Please describe your project in at least 3 characters.");
      document.getElementById("idea")?.focus();
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);
    setIsSubmitting(true);

    const fullPrompt = `Goal: ${trimmed}\nVisual Style: ${selectedStyle}`;
    const activeKey = submissionId || generateSubmissionId();

    try {
      const result = await createProject(fullPrompt, activeKey);

      if ("error" in result && result.error) {
        if (result.error === "Unauthorized") {
          // Preserve prompt and idempotency identifier in sessionStorage through auth redirect
          sessionStorage.setItem(
            PENDING_BRIEF_STORAGE_KEY,
            JSON.stringify({
              idea: trimmed,
              selectedStyle,
              selectedExample,
              submissionId: activeKey,
              pendingSubmit: true,
              savedAt: Date.now(),
            })
          );

          setStatusMessage("Please sign in to start generation. Preserving your brief...");
          router.push(`/sign-in?redirect_url=${encodeURIComponent("/builder?resume=true")}`);
          return;
        }

        setErrorMessage(result.error);
        setIsSubmitting(false);
        return;
      }

      if ("id" in result && result.id) {
        sessionStorage.removeItem(PENDING_BRIEF_STORAGE_KEY);
        router.push(`/projects/${result.id}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create project";
      setErrorMessage(message);
      setIsSubmitting(false);
    }
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
        <p className="notice">Create a brief or launch full-stack generation directly with CodeMytra.</p>
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
            onChange={(e) => {
              setIdea(e.target.value);
              setErrorMessage(null);
            }}
          />

          <div className="actions">
            <button
              className="btn orange"
              id="startProject"
              type="button"
              onClick={handleGenerateProject}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Starting generation..." : "Generate application →"}
            </button>
            <button
              className="btn"
              id="makeBrief"
              type="button"
              onClick={handleCreateBrief}
            >
              Create project brief
            </button>
            <Link href="/how-it-works" className="btn alt">
              Learn the process
            </Link>
          </div>

          {errorMessage && (
            <div
              className="error-recovery-banner"
              style={{
                marginTop: "14px",
                padding: "12px 16px",
                borderRadius: "8px",
                backgroundColor: "rgba(229, 72, 77, 0.1)",
                border: "1px solid rgba(229, 72, 77, 0.3)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <p className="notice" style={{ color: "#e5484d", margin: 0, fontWeight: 500 }}>
                {errorMessage}
              </p>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn orange"
                  onClick={handleGenerateProject}
                  disabled={isSubmitting}
                  style={{ padding: "6px 12px", fontSize: "12px" }}
                >
                  {isSubmitting ? "Retrying..." : "Retry generation"}
                </button>
                <span style={{ fontSize: "12px", color: "var(--muted, #888)" }}>
                  Your brief and configuration remain preserved.
                </span>
              </div>
            </div>
          )}

          {statusMessage && (
            <p className="notice" style={{ color: "#2b7a4b", marginTop: "12px" }}>
              {statusMessage}
            </p>
          )}
        </div>

        {brief && (
          <div id="brief" aria-live="polite" style={{ margin: "20px 0" }}>
            <div className="card">
              <span className="eyebrow" style={{ color: "var(--accent)" }}>Ready to build</span>
              <h3 style={{ marginTop: "4px" }}>Your starting brief</h3>
              <p style={{ whiteSpace: "pre-line", marginTop: "8px" }}>{brief}</p>
              <div style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap" }}>
                <button
                  className="btn orange"
                  id="buildFromBrief"
                  type="button"
                  onClick={handleGenerateProject}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Starting generation..." : "Generate application →"}
                </button>
                <button className="btn" type="button" onClick={handleCopy}>
                  {copyStatus}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
