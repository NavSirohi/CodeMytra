import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRDSchema,
  DesignSpecSchema,
  ArchitectureSpecSchema,
  QAReportSchema,
} from "../src/server/agent-contracts/schemas";
import { isValidTransition } from "../src/server/orchestration/state-machine";
import { GenerationRunStatus } from "../src/generated/prisma/client";
import { runQAInspector } from "../src/server/agents/qa";

describe("Multi-Agent Contracts & State Flow", () => {
  it("validates well-formed PRD schema", () => {
    const rawPRD = {
      projectName: "Boutique Bakery",
      summary: "Custom online bakery with ordering system",
      targetAudience: "Local pastry lovers",
      coreFeatures: [
        { name: "Menu Catalog", description: "List of pastries", priority: "MUST" },
        { name: "Order Custom Cake", description: "Form for custom orders", priority: "SHOULD" },
      ],
      pages: [
        { route: "/", title: "Home", purpose: "Hero and featured items", keyComponents: ["Hero", "Gallery"] },
        { route: "/order", title: "Order", purpose: "Checkout", keyComponents: ["OrderForm"] },
      ],
      dataEntities: [{ name: "Product", fields: ["id", "title", "price"] }],
      userFlows: [{ name: "Order a cake", steps: ["Browse menu", "Add to cart", "Submit order"] }],
    };

    const parsed = PRDSchema.parse(rawPRD);
    assert.equal(parsed.projectName, "Boutique Bakery");
    assert.equal(parsed.coreFeatures.length, 2);
    assert.equal(parsed.pages.length, 2);
  });

  it("validates well-formed DesignSpec schema", () => {
    const rawDesign = {
      aestheticTheme: "warm-artisan",
      colorPalette: {
        primary: "#d97706",
        secondary: "#78350f",
        accent: "#f59e0b",
        background: "#fffbeb",
        surface: "#fef3c7",
        text: "#451a03",
      },
      typography: {
        headingFont: "Playfair Display",
        bodyFont: "Inter",
      },
      layoutStyle: "warm-editorial",
      componentGuidelines: [
        { componentName: "BakeryCard", stylingRules: "rounded-2xl border p-4 shadow-md" },
      ],
    };

    const parsed = DesignSpecSchema.parse(rawDesign);
    assert.equal(parsed.aestheticTheme, "warm-artisan");
    assert.equal(parsed.colorPalette.primary, "#d97706");
  });

  it("validates ArchitectureSpec schema and file ownership boundaries", () => {
    const rawArch = {
      appType: "nextjs-fullstack",
      routeEndpoints: [
        { path: "/", type: "page", purpose: "Landing page" },
        { path: "/api/orders", type: "api", purpose: "Process bakery orders" },
      ],
      databaseModels: [{ modelName: "Order", fields: ["id", "customerEmail", "total"] }],
      fileOwnership: {
        frontend: ["app/**/*.tsx", "components/**/*.tsx"],
        backend: ["app/api/**/*.ts", "server/**/*.ts"],
        database: ["prisma/schema.prisma"],
      },
      dependencies: ["lucide-react"],
    };

    const parsed = ArchitectureSpecSchema.parse(rawArch);
    assert.equal(parsed.routeEndpoints.length, 2);
    assert.ok(parsed.fileOwnership.frontend);
    assert.ok(parsed.fileOwnership.backend);
  });

  it("QA Inspector verifies healthy project files", async () => {
    const files: Record<string, string> = {
      "app/page.tsx": "export default function Page() { return <h1>Bakery</h1>; }",
      "components/header.tsx": "export function Header() { return <header /> }",
    };

    const report = await runQAInspector({
      files,
      summary: "Completed bakery homepage with modern styled header.",
    });

    assert.equal(report.passed, true);
    assert.ok(report.score >= 80);
    assert.equal(report.repairNeeded, false);
    assert.ok(QAReportSchema.parse(report));
  });

  it("QA Inspector flags missing entrypoint or credentials", async () => {
    const badFiles: Record<string, string> = {
      "components/random.tsx": "export const x = 1;",
    };

    const report = await runQAInspector({
      files: badFiles,
      summary: "Random component",
    });

    assert.equal(report.passed, false);
    assert.equal(report.repairNeeded, true);
  });

  it("validates end-to-end multi-agent state progression", () => {
    assert.equal(isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.PLANNING), true);
    assert.equal(isValidTransition(GenerationRunStatus.PLANNING, GenerationRunStatus.DESIGNING), true);
    assert.equal(isValidTransition(GenerationRunStatus.DESIGNING, GenerationRunStatus.ARCHITECTING), true);
    assert.equal(isValidTransition(GenerationRunStatus.ARCHITECTING, GenerationRunStatus.RUNNING), true);
    assert.equal(isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.VALIDATING), true);
    assert.equal(isValidTransition(GenerationRunStatus.VALIDATING, GenerationRunStatus.COMPLETED), true);
  });

  it("validates full-stack appointment booking contract with models and route handlers", () => {
    const bookingPRD = {
      projectName: "Saloon & Clinic Appointments",
      summary: "Full-stack appointment scheduling system with double-booking prevention",
      targetAudience: "Customers and clinic staff",
      coreFeatures: [
        { name: "Slot Picker", description: "Select date and available time slot", priority: "MUST" as const },
        { name: "Double Booking Guard", description: "Atomic slot reservation", priority: "MUST" as const },
      ],
      pages: [
        { route: "/", title: "Booking Calendar", purpose: "Select specialist and slot", keyComponents: ["Calendar", "SlotGrid"] },
        { route: "/confirmation", title: "Confirmation", purpose: "View booked appointment", keyComponents: ["Receipt"] },
      ],
      dataEntities: [
        { name: "Service", fields: ["id", "title", "durationMinutes", "price"], relationships: ["hasMany Bookings"] },
        { name: "Booking", fields: ["id", "serviceId", "customerName", "slotTime", "status"], relationships: ["belongsTo Service"] },
      ],
      userFlows: [
        { name: "Book Slot", steps: ["Select Service", "Pick Time Slot", "Fill Details", "Confirm Booking"] },
      ],
    };

    const parsedPRD = PRDSchema.parse(bookingPRD);
    assert.equal(parsedPRD.dataEntities?.length, 2);
    assert.equal(parsedPRD.userFlows?.length, 1);

    const bookingArch = {
      appType: "nextjs-fullstack",
      routeEndpoints: [
        { path: "/", type: "page" as const, purpose: "Main booking UI" },
        { path: "/api/services", type: "api" as const, purpose: "List active services" },
        { path: "/api/bookings", type: "api" as const, purpose: "Create and validate appointment" },
      ],
      databaseModels: [
        { modelName: "Service", fields: ["id", "title", "price"] },
        { modelName: "Booking", fields: ["id", "serviceId", "slotTime", "customerEmail"] },
      ],
      fileOwnership: {
        frontend: ["app/page.tsx", "components/**/*.tsx"],
        backend: ["app/api/**/*.ts"],
        database: ["prisma/schema.prisma", "lib/db.ts"],
      },
      dependencies: ["date-fns"],
    };

    const parsedArch = ArchitectureSpecSchema.parse(bookingArch);
    assert.equal(parsedArch.routeEndpoints.length, 3);
    assert.equal(parsedArch.databaseModels?.length, 2);
  });
});
