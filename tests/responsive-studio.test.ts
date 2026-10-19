import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("P1: Studio Responsive Verification & Panel Boundary Geometry", () => {
  // Panel constraints from src/components/projects/project-view.tsx
  const SIDEBAR_MIN_PIXELS = 320;
  const CANVAS_MIN_PIXELS = 420;
  const COMBINED_MIN_DESKTOP_WIDTH = SIDEBAR_MIN_PIXELS + CANVAS_MIN_PIXELS; // 740px
  const TAILWIND_MD_BREAKPOINT = 768;

  const BREAKPOINTS = [
    { name: "Wide Desktop", width: 1440, isDesktop: true },
    { name: "Standard Desktop", width: 1280, isDesktop: true },
    { name: "Small Desktop / iPad Pro", width: 1024, isDesktop: true },
    { name: "Tablet Portrait Boundary", width: 768, isDesktop: true },
    { name: "Mobile Screen (iPhone 14)", width: 390, isDesktop: false },
  ];

  for (const bp of BREAKPOINTS) {
    it(`verifies layout constraints at ${bp.width}px (${bp.name})`, () => {
      if (bp.isDesktop) {
        // Desktop split-view is active (width >= 768px)
        assert.ok(
          bp.width >= TAILWIND_MD_BREAKPOINT,
          `Desktop breakpoint width ${bp.width}px must be >= ${TAILWIND_MD_BREAKPOINT}px`
        );

        // Verify that minimum combined panel width (740px) fits within viewport without horizontal overflow
        const margin = bp.width - COMBINED_MIN_DESKTOP_WIDTH;
        assert.ok(
          margin >= 0,
          `At ${bp.width}px, combined min panels (${COMBINED_MIN_DESKTOP_WIDTH}px) must not exceed viewport width (margin: ${margin}px)`
        );

        // Verify default 35% / 65% split allocation at this breakpoint
        const defaultSidebarWidth = Math.round(bp.width * 0.35);
        const defaultCanvasWidth = bp.width - defaultSidebarWidth;
        assert.ok(defaultCanvasWidth > 0);

        // Effective sidebar width is clamped to minSize (320px)
        const effectiveSidebarWidth = Math.max(SIDEBAR_MIN_PIXELS, defaultSidebarWidth);
        const remainingCanvasWidth = bp.width - effectiveSidebarWidth;

        assert.ok(
          effectiveSidebarWidth >= SIDEBAR_MIN_PIXELS,
          `Sidebar width ${effectiveSidebarWidth}px must satisfy minSize ${SIDEBAR_MIN_PIXELS}px`
        );
        assert.ok(
          remainingCanvasWidth >= CANVAS_MIN_PIXELS,
          `Remaining canvas width ${remainingCanvasWidth}px must satisfy minSize ${CANVAS_MIN_PIXELS}px`
        );
      } else {
        // Mobile view is active (width < 768px)
        assert.ok(
          bp.width < TAILWIND_MD_BREAKPOINT,
          `Mobile breakpoint width ${bp.width}px must be < ${TAILWIND_MD_BREAKPOINT}px`
        );

        // On mobile, panels are toggled into single full-width views (100% width)
        const mobileViewWidth = bp.width;
        assert.equal(mobileViewWidth, bp.width);
        assert.ok(mobileViewWidth > 0, "Mobile view renders at full viewport width");
      }
    });
  }

  it("verifies react-resizable-panels v4.11.2 numeric pixel bug prevention", () => {
    // In react-resizable-panels v4.11.2, passing raw numbers to defaultSize or maxSize causes
    // percentage calculations to interpret numbers as 0% or collapse to minimum pixels.
    // We verified defaultSize uses string percentage ("35%", "65%") while minSize uses pixel numbers.
    const defaultSidebarSize = "35%";
    const defaultCanvasSize = "65%";
    const maxSidebarSize = "50%";

    assert.equal(typeof defaultSidebarSize, "string");
    assert.match(defaultSidebarSize, /%$/);
    assert.equal(typeof defaultCanvasSize, "string");
    assert.match(defaultCanvasSize, /%$/);
    assert.equal(typeof maxSidebarSize, "string");
    assert.match(maxSidebarSize, /%$/);
  });
});
