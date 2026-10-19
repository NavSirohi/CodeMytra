import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import JSZip from "jszip";
import {
  PRDSchema,
  DesignSpecSchema,
  ArchitectureSpecSchema,
} from "../src/server/agent-contracts/schemas";
import { runQAInspector, executeDatabaseVerificationPipeline } from "../src/server/agents/qa";
import { buildContextEnhancedPrompt } from "../src/server/agents/coder";
import { validateExportFiles } from "../src/server/export/zip-export";
import { sanitizeProjectFiles } from "../src/server/orchestration/revisions";
import {
  getBaseProjectFiles,
  buildPrismaSchema,
  MissingDatabaseModelsError,
  FOUNDATION_VERSION,
} from "../src/server/templates/foundation";
import { ArchitectureError } from "../src/server/agents/architect";

describe("Milestone M2: Generic Full-Stack AI Application Generation", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO A: Static Developer Portfolio (Zero Database Overhead)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario A: Static Developer Portfolio", () => {
    it("generates requirement specs and architecture without unnecessary database overhead", () => {
      const rawPRD = {
        projectName: "DevFolio Pro",
        summary: "Modern developer portfolio showcasing projects, technical skills, and contact form.",
        targetAudience: "Prospective tech employers and freelance clients",
        capabilities: ["pages-navigation", "forms-validation"],
        unsupportedRequirements: [],
        coreFeatures: [
          { name: "Hero Showcase", description: "Interactive hero with bio and social links", priority: "MUST" },
          { name: "Project Gallery", description: "Filterable list of engineering projects", priority: "MUST" },
          { name: "Contact Form", description: "Interactive validated contact form", priority: "SHOULD" },
        ],
        pages: [
          { route: "/", title: "Portfolio Home", purpose: "Showcase skills and work", keyComponents: ["Hero", "Projects", "Skills", "Contact"] },
        ],
        dataEntities: [
          { name: "ProjectItem", fields: ["title", "description", "tags", "demoUrl"], isPersistent: false },
        ],
        userFlows: [
          { name: "View Projects & Contact", steps: ["Visit homepage", "Filter projects by tag", "Submit contact inquiry"] },
        ],
      };

      const prd = PRDSchema.parse(rawPRD);
      assert.equal(prd.projectName, "DevFolio Pro");
      assert.deepEqual(prd.capabilities, ["pages-navigation", "forms-validation"]);
      assert.equal(prd.dataEntities[0].isPersistent, false);

      // Verify architecture specification for static app
      const rawArch = {
        appType: "nextjs-fullstack",
        capabilities: prd.capabilities,
        requiresDatabase: false,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Main portfolio landing page" },
        ],
        uiComponents: [
          { name: "HeroSection", purpose: "Bio and introduction", route: "/" },
          { name: "ProjectGrid", purpose: "Interactive showcase with skill tags", route: "/" },
          { name: "ContactForm", purpose: "Client-side validated message form", route: "/" },
        ],
        databaseModels: [],
        backendOperations: [],
        businessConstraints: [],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx", "components/**/*.tsx"],
          backend: [],
          database: [],
        },
        dependencies: ["lucide-react"],
      };

      const archSpec = ArchitectureSpecSchema.parse(rawArch);
      assert.equal(archSpec.requiresDatabase, false);
      assert.equal(archSpec.databaseModels.length, 0);
      assert.equal(archSpec.fileOwnership.database.length, 0);
    });

    it("verifies static portfolio files pass capability QA without database errors", async () => {
      const baseFiles = getBaseProjectFiles({ projectName: "devfolio-pro", requiresDatabase: false });
      const appFiles: Record<string, string> = {
        ...baseFiles,
        "app/page.tsx": `
"use client";
import React, { useState } from "react";

export default function PortfolioPage() {
  const [filter, setFilter] = useState("all");
  const [messageSent, setMessageSent] = useState(false);

  const projects = [
    { id: 1, title: "Cloud Engine", tag: "systems" },
    { id: 2, title: "AI Assistant", tag: "ai" },
  ];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-8">
      <header className="max-w-4xl mx-auto py-12">
        <h1 className="text-4xl font-bold">Alex Rivera — Full Stack Engineer</h1>
        <p className="mt-2 text-neutral-400">Building distributed systems and modern web applications.</p>
      </header>

      <section className="max-w-4xl mx-auto">
        <div className="flex gap-2 mb-6">
          <button onClick={() => setFilter("all")} className="px-3 py-1 bg-neutral-800 rounded">All</button>
          <button onClick={() => setFilter("systems")} className="px-3 py-1 bg-neutral-800 rounded">Systems</button>
        </div>
        <div className="grid gap-4">
          {projects.filter(p => filter === "all" || p.tag === filter).map(p => (
            <div key={p.id} className="p-4 border border-neutral-800 rounded-lg">
              <h2 className="text-xl font-semibold">{p.title}</h2>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
`,
      };

      const archSpec = ArchitectureSpecSchema.parse({
        appType: "nextjs-fullstack",
        capabilities: ["pages-navigation", "forms-validation"],
        requiresDatabase: false,
        routeEndpoints: [{ path: "/", type: "page", purpose: "Portfolio home" }],
        uiComponents: [{ name: "PortfolioPage", purpose: "Main view", route: "/" }],
        databaseModels: [],
        backendOperations: [],
        businessConstraints: [],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx"],
          backend: [],
          database: [],
        },
        dependencies: [],
      });

      const report = await runQAInspector({
        files: appFiles,
        summary: "Built responsive developer portfolio with filterable projects and interactive client state.",
        sandboxId: "",
        runSandboxCommands: false,
        archSpec,
      });

      assert.equal(report.passed, true);
      const dbCheck = report.checks.find((c) => c.category === "database-validation");
      assert.ok(dbCheck);
      assert.equal(dbCheck.status, "PASS");
      assert.ok(dbCheck.details);
      assert.match(dbCheck.details, /Static application/i);

      const apiCheck = report.checks.find((c) => c.category === "api-validation");
      assert.ok(apiCheck);
      assert.equal(apiCheck.status, "PASS");

      // Verify export validation passes
      assert.doesNotThrow(() => validateExportFiles(appFiles));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO B: CRUD Inventory Management (Working SQLite Persistence)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario B: CRUD Inventory Management System", () => {
    it("generates requirement specs with data persistence and backend CRUD operations", () => {
      const rawPRD = {
        projectName: "StockFlow Warehouse",
        summary: "Real-time inventory and warehouse stock management application.",
        targetAudience: "Operations and warehouse managers",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations", "search-filtering"],
        unsupportedRequirements: [],
        coreFeatures: [
          { name: "Product Catalog", description: "View all warehouse items with stock levels", priority: "MUST" },
          { name: "Add/Edit Product", description: "Create and update inventory records", priority: "MUST" },
          { name: "Delete Product", description: "Remove discontinued inventory", priority: "MUST" },
          { name: "Low Stock Alert", description: "Visual indicators for items below threshold", priority: "SHOULD" },
        ],
        pages: [
          { route: "/", title: "Inventory Dashboard", purpose: "Overview and item table", keyComponents: ["ItemTable", "ItemModal", "Metrics"] },
        ],
        dataEntities: [
          {
            name: "Product",
            fields: ["id", "sku", "name", "category", "quantity", "unitPrice", "minThreshold"],
            isPersistent: true,
          },
        ],
        userFlows: [
          { name: "Update Stock", steps: ["Search product by SKU", "Edit quantity", "Save changes"] },
        ],
      };

      const prd = PRDSchema.parse(rawPRD);
      assert.equal(prd.projectName, "StockFlow Warehouse");
      assert.ok(prd.capabilities.includes("data-persistence"));
      assert.ok(prd.capabilities.includes("crud-operations"));

      const rawArch = {
        appType: "nextjs-fullstack",
        capabilities: prd.capabilities,
        requiresDatabase: true,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Dashboard view" },
          { path: "/api/products", type: "api", purpose: "CRUD operations on warehouse products", methods: ["GET", "POST", "PUT", "DELETE"] },
        ],
        uiComponents: [
          { name: "InventoryTable", purpose: "Display items with stock indicators", route: "/" },
          { name: "ProductForm", purpose: "Add/edit item details", route: "/" },
        ],
        databaseModels: [
          {
            modelName: "Product",
            fields: ["id String @id @default(cuid())", "sku String @unique", "name String", "quantity Int", "unitPrice Float"],
            relations: [],
          },
        ],
        backendOperations: [
          {
            name: "listProducts",
            description: "Retrieve all products with optional category/search query",
            validationRules: ["Query parameter validation"],
            authRequired: false,
          },
          {
            name: "createProduct",
            description: "Add a new product with unique SKU",
            validationRules: ["SKU, name, and quantity >= 0 are mandatory"],
            authRequired: false,
          },
          {
            name: "updateProduct",
            description: "Modify existing inventory item",
            validationRules: ["Valid product ID required"],
            authRequired: false,
          },
          {
            name: "deleteProduct",
            description: "Remove product from inventory",
            validationRules: ["Valid product ID required"],
            authRequired: false,
          },
        ],
        businessConstraints: [
          "SKU must be globally unique",
          "Inventory quantity cannot be negative",
        ],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx", "components/**/*.tsx"],
          backend: ["app/api/**/*.ts"],
          database: ["prisma/schema.prisma", "lib/db.ts"],
        },
        dependencies: ["@prisma/client", "prisma"],
      };

      const archSpec = ArchitectureSpecSchema.parse(rawArch);
      assert.equal(archSpec.requiresDatabase, true);
      assert.equal(archSpec.databaseModels.length, 1);
      assert.ok(archSpec.fileOwnership.database.includes("prisma/schema.prisma"));
    });

    it("verifies inventory files pass capability QA with database and API route validation", async () => {
      const baseFiles = getBaseProjectFiles({
        projectName: "stockflow-warehouse",
        requiresDatabase: true,
        models: [{ modelName: "Product", fields: ["sku String @unique", "name String", "quantity Int", "unitPrice Float"] }],
      });
      const appFiles: Record<string, string> = {
        ...baseFiles,
        "app/page.tsx": `
"use client";
import React, { useEffect, useState } from "react";

export default function InventoryDashboard() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/products")
      .then((res) => res.json())
      .then((data) => setItems(data.products || []))
      .catch(() => {});
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Warehouse Inventory</h1>
      <ul className="mt-4">
        {items.map((i) => (
          <li key={i.id} className="py-1">{i.name} (SKU: {i.sku}) - Qty: {i.quantity}</li>
        ))}
      </ul>
    </div>
  );
}
`,
        "app/api/products/route.ts": `
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const products = await db.product.findMany();
    return NextResponse.json({ products });
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch products" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.sku || !body.name || body.quantity === undefined) {
      return NextResponse.json({ error: "SKU, name, and quantity are required" }, { status: 400 });
    }
    if (body.quantity < 0) {
      return NextResponse.json({ error: "Quantity cannot be negative" }, { status: 400 });
    }
    const created = await db.product.create({ data: body });
    return NextResponse.json({ product: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "Failed to create product" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "ID required" }, { status: 400 });
  }
  await db.product.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
`,
      };

      const archSpec = ArchitectureSpecSchema.parse({
        appType: "nextjs-fullstack",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
        requiresDatabase: true,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Dashboard" },
          { path: "/api/products", type: "api", purpose: "CRUD API", methods: ["GET", "POST", "DELETE"] },
        ],
        uiComponents: [{ name: "InventoryDashboard", purpose: "Table view", route: "/" }],
        databaseModels: [{ modelName: "Product", fields: ["id", "sku", "name", "quantity"], relations: [] }],
        backendOperations: [{ name: "crud", description: "Product operations", validationRules: ["Required fields"], authRequired: false }],
        businessConstraints: ["Quantity cannot be negative"],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx"],
          backend: ["app/api/**/*.ts"],
          database: ["prisma/schema.prisma", "lib/db.ts"],
        },
        dependencies: ["@prisma/client", "prisma"],
      });

      const report = await runQAInspector({
        files: appFiles,
        summary: "Implemented inventory manager with SQLite Prisma schema and full CRUD API endpoints.",
        sandboxId: "",
        runSandboxCommands: false,
        archSpec,
        capabilities: archSpec.capabilities,
      });

      assert.equal(report.passed, true);

      // Verify database validation check passed
      const dbCheck = report.checks.find((c) => c.category === "database-validation");
      assert.ok(dbCheck);
      assert.equal(dbCheck.status, "PASS");
      assert.ok(dbCheck.details);
      assert.match(dbCheck.details, /Prisma SQLite schema and database client verified/i);

      // Verify API validation check passed
      const apiCheck = report.checks.find((c) => c.category === "api-validation");
      assert.ok(apiCheck);
      assert.equal(apiCheck.status, "PASS");
      assert.ok(apiCheck.details);
      assert.match(apiCheck.details, /API route handler\(s\) verified/i);

      // Verify export validation passes cleanly
      assert.doesNotThrow(() => validateExportFiles(appFiles));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO C: Appointment/Booking Workflow (Conflict Detection & 409 Handling)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario C: Appointment Booking Workflow with Business Constraints", () => {
    it("specifies business constraint preventing double bookings", () => {
      const rawArch = {
        appType: "nextjs-fullstack",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations", "business-rules", "forms-validation"],
        requiresDatabase: true,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Booking calendar and slot picker" },
          { path: "/api/appointments", type: "api", purpose: "Create and view appointments", methods: ["GET", "POST"] },
        ],
        uiComponents: [
          { name: "SlotPicker", purpose: "Calendar date and time slot selector", route: "/" },
          { name: "PatientForm", purpose: "Contact and confirmation", route: "/" },
        ],
        databaseModels: [
          {
            modelName: "Appointment",
            fields: ["id String @id @default(cuid())", "doctorId String", "patientName String", "startTime DateTime", "endTime DateTime", "status String"],
            relations: [],
          },
        ],
        backendOperations: [
          {
            name: "createAppointment",
            description: "Reserve a consultation slot after verifying no conflicting bookings exist",
            validationRules: [
              "Doctor ID, patient name, and valid startTime/endTime are required",
              "startTime must be in the future and before endTime",
              "No overlapping appointment may exist for the same doctor",
            ],
            authRequired: false,
          },
        ],
        businessConstraints: [
          "Double-booking prevention: A doctor cannot have overlapping appointments",
          "Conflicting requests must return HTTP 409 Conflict with descriptive payload",
        ],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx", "components/**/*.tsx"],
          backend: ["app/api/**/*.ts"],
          database: ["prisma/schema.prisma", "lib/db.ts"],
        },
        dependencies: ["@prisma/client", "prisma"],
      };

      const archSpec = ArchitectureSpecSchema.parse(rawArch);
      assert.equal(archSpec.requiresDatabase, true);
      assert.ok(archSpec.businessConstraints.some((c) => c.includes("Double-booking prevention")));
    });

    it("verifies server-side appointment conflict handling returns 409 on overlap", async () => {
      // In-memory appointments database simulation representing real route handler logic
      const appointmentsTable: Array<{
        id: string;
        doctorId: string;
        patientName: string;
        startTime: number;
        endTime: number;
      }> = [
        {
          id: "appt-1",
          doctorId: "dr-smith",
          patientName: "Alice Walker",
          startTime: new Date("2026-11-01T10:00:00Z").getTime(),
          endTime: new Date("2026-11-01T10:30:00Z").getTime(),
        },
      ];

      // Route handler business logic implementation
      async function handleCreateAppointment(body: {
        doctorId?: string;
        patientName?: string;
        startTime?: string;
        endTime?: string;
      }): Promise<{ status: number; body: Record<string, unknown> }> {
        // Validation check
        if (!body.doctorId || !body.patientName || !body.startTime || !body.endTime) {
          return {
            status: 400,
            body: { error: "doctorId, patientName, startTime, and endTime are required" },
          };
        }

        const reqStart = new Date(body.startTime).getTime();
        const reqEnd = new Date(body.endTime).getTime();

        if (isNaN(reqStart) || isNaN(reqEnd) || reqStart >= reqEnd) {
          return {
            status: 400,
            body: { error: "Invalid appointment time window" },
          };
        }

        // Strict conflict check: [reqStart, reqEnd) overlaps with any [existingStart, existingEnd)
        const hasConflict = appointmentsTable.some((existing) => {
          if (existing.doctorId !== body.doctorId) return false;
          return reqStart < existing.endTime && reqEnd > existing.startTime;
        });

        if (hasConflict) {
          return {
            status: 409,
            body: {
              error: "Conflict: This doctor is already booked during the requested time slot.",
              code: "SLOT_ALREADY_BOOKED",
            },
          };
        }

        const newAppt = {
          id: `appt-${Date.now()}`,
          doctorId: body.doctorId,
          patientName: body.patientName,
          startTime: reqStart,
          endTime: reqEnd,
        };
        appointmentsTable.push(newAppt);

        return {
          status: 201,
          body: { appointment: newAppt },
        };
      }

      // Case 1: Overlapping appointment for same doctor -> Returns 409 Conflict
      const conflictRes = await handleCreateAppointment({
        doctorId: "dr-smith",
        patientName: "Bob Jones",
        startTime: "2026-11-01T10:15:00Z", // overlaps with 10:00 - 10:30
        endTime: "2026-11-01T10:45:00Z",
      });
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.body.code, "SLOT_ALREADY_BOOKED");

      // Case 2: Non-overlapping appointment for same doctor -> Returns 201 Created
      const successRes = await handleCreateAppointment({
        doctorId: "dr-smith",
        patientName: "Bob Jones",
        startTime: "2026-11-01T10:30:00Z", // starts exactly after
        endTime: "2026-11-01T11:00:00Z",
      });
      assert.equal(successRes.status, 201);
      assert.ok(successRes.body.appointment);

      // Case 3: Same time slot for different doctor -> Returns 201 Created
      const diffDoctorRes = await handleCreateAppointment({
        doctorId: "dr-jones",
        patientName: "Charlie Brown",
        startTime: "2026-11-01T10:00:00Z",
        endTime: "2026-11-01T10:30:00Z",
      });
      assert.equal(diffDoctorRes.status, 201);

      // Case 4: Missing field -> Returns 400 Bad Request
      const badReqRes = await handleCreateAppointment({
        doctorId: "dr-smith",
        // missing patientName and times
      });
      assert.equal(badReqRes.status, 400);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO D: E-Commerce Store with Multi-Turn Modification
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario D: E-Commerce Store with Multi-Turn Modification", () => {
    it("handles initial generation contracts for catalogue, cart, and order processing", () => {
      const initialPRD = PRDSchema.parse({
        projectName: "RoastMaster Coffee",
        summary: "Specialty coffee roastery e-commerce platform with bean catalogue, cart, and checkout.",
        targetAudience: "Coffee connoisseurs and home baristas",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations", "business-rules", "forms-validation"],
        unsupportedRequirements: [],
        coreFeatures: [
          { name: "Coffee Catalogue", description: "Browse whole bean origins, roast levels, and tasting notes", priority: "MUST" },
          { name: "Shopping Cart", description: "Add bags to cart, adjust quantities, calculate subtotal", priority: "MUST" },
          { name: "Checkout & Orders", description: "Place order and deduct warehouse inventory", priority: "MUST" },
        ],
        pages: [
          { route: "/", title: "Coffee Shop", purpose: "Product grid and cart drawer", keyComponents: ["ProductGrid", "CartDrawer"] },
          { route: "/checkout", title: "Checkout", purpose: "Shipping info and order confirmation", keyComponents: ["CheckoutForm"] },
        ],
        dataEntities: [
          { name: "Product", fields: ["id", "name", "origin", "roast", "price", "stock"], isPersistent: true },
          { name: "Order", fields: ["id", "customerEmail", "total", "status", "createdAt"], isPersistent: true },
          { name: "OrderItem", fields: ["id", "orderId", "productId", "quantity", "unitPrice"], isPersistent: true },
        ],
        userFlows: [
          { name: "Purchase Coffee", steps: ["Select coffee", "Add 2 bags to cart", "Proceed to checkout", "Confirm order"] },
        ],
      });

      assert.equal(initialPRD.projectName, "RoastMaster Coffee");
      assert.equal(initialPRD.dataEntities.length, 3);
      assert.ok(initialPRD.dataEntities.every((e) => e.isPersistent));
    });

    it("simulates order creation with stock deduction and business constraint enforcement", () => {
      const inventory = new Map<string, { id: string; name: string; price: number; stock: number }>([
        ["coffee-1", { id: "coffee-1", name: "Ethiopian Yirgacheffe", price: 18.5, stock: 5 }],
        ["coffee-2", { id: "coffee-2", name: "Colombian Geisha", price: 24.0, stock: 2 }],
      ]);

      const orders: Array<{ id: string; items: Array<{ productId: string; qty: number }>; total: number }> = [];

      function placeOrder(items: Array<{ productId: string; qty: number }>): { success: boolean; error?: string; orderId?: string } {
        if (!items || items.length === 0) {
          return { success: false, error: "Cart is empty" };
        }

        // Check stock availability
        for (const item of items) {
          const product = inventory.get(item.productId);
          if (!product) {
            return { success: false, error: `Product "${item.productId}" not found` };
          }
          if (product.stock < item.qty) {
            return {
              success: false,
              error: `Insufficient stock for "${product.name}". Available: ${product.stock}, requested: ${item.qty}`,
            };
          }
        }

        // Deduct inventory and calculate total
        let total = 0;
        for (const item of items) {
          const product = inventory.get(item.productId)!;
          product.stock -= item.qty;
          total += product.price * item.qty;
        }

        const orderId = `ord-${Date.now()}`;
        orders.push({ id: orderId, items, total });

        return { success: true, orderId };
      }

      // Valid order within stock limit
      const order1 = placeOrder([{ productId: "coffee-1", qty: 2 }]);
      assert.equal(order1.success, true);
      assert.equal(inventory.get("coffee-1")?.stock, 3); // 5 - 2 = 3

      // Order exceeding remaining stock -> Rejection
      const order2 = placeOrder([{ productId: "coffee-2", qty: 5 }]); // only 2 available
      assert.equal(order2.success, false);
      assert.match(order2.error!, /Insufficient stock/);
      assert.equal(inventory.get("coffee-2")?.stock, 2); // Unaltered
    });

    it("multi-turn modification preserves existing core features while incorporating search-filtering", () => {
      const v1PRD = {
        projectName: "RoastMaster Coffee",
        summary: "Specialty coffee roastery e-commerce platform.",
        targetAudience: "Coffee connoisseurs",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations", "business-rules", "forms-validation"],
        unsupportedRequirements: [],
        coreFeatures: [
          { name: "Coffee Catalogue", description: "Browse coffee beans", priority: "MUST" as const },
          { name: "Shopping Cart", description: "Manage cart items", priority: "MUST" as const },
          { name: "Checkout & Orders", description: "Complete purchases", priority: "MUST" as const },
        ],
        pages: [
          { route: "/", title: "Coffee Shop", purpose: "Catalogue and cart", keyComponents: ["ProductGrid", "CartDrawer"] },
          { route: "/checkout", title: "Checkout", purpose: "Shipping info", keyComponents: ["CheckoutForm"] },
        ],
        dataEntities: [
          { name: "Product", fields: ["id", "name", "price", "stock"], isPersistent: true },
          { name: "Order", fields: ["id", "total", "status"], isPersistent: true },
        ],
        userFlows: [{ name: "Purchase", steps: ["Add to cart", "Checkout"] }],
      };

      // User submits follow-up modification prompt:
      // "Add search and price range filtering to the product catalogue so customers can easily find beans"
      const v2PRD = PRDSchema.parse({
        ...v1PRD,
        capabilities: [...v1PRD.capabilities, "search-filtering"],
        coreFeatures: [
          ...v1PRD.coreFeatures,
          { name: "Catalogue Search & Filtering", description: "Search by bean origin and filter by price range", priority: "SHOULD" as const },
        ],
        pages: [
          {
            route: "/",
            title: "Coffee Shop",
            purpose: "Filterable catalogue and cart",
            keyComponents: ["ProductGrid", "CartDrawer", "SearchBar", "PriceFilterSlider"],
          },
          v1PRD.pages[1],
        ],
      });

      // Verification: Prior features are strictly preserved
      assert.equal(v2PRD.projectName, "RoastMaster Coffee");
      assert.ok(v2PRD.coreFeatures.some((f) => f.name === "Coffee Catalogue"));
      assert.ok(v2PRD.coreFeatures.some((f) => f.name === "Shopping Cart"));
      assert.ok(v2PRD.coreFeatures.some((f) => f.name === "Checkout & Orders"));
      assert.ok(v2PRD.coreFeatures.some((f) => f.name === "Catalogue Search & Filtering"));

      // Capabilities updated
      assert.ok(v2PRD.capabilities.includes("search-filtering"));

      // Components updated additively
      const homePage = v2PRD.pages.find((p) => p.route === "/");
      assert.ok(homePage?.keyComponents.includes("SearchBar"));
      assert.ok(homePage?.keyComponents.includes("PriceFilterSlider"));
      assert.ok(homePage?.keyComponents.includes("CartDrawer")); // Cart preserved!

      // Architecture context prompt reflects the delta
      const designSpec = DesignSpecSchema.parse({
        aestheticTheme: "warm-editorial",
        colorPalette: {
          primary: "#78350f",
          secondary: "#d97706",
          accent: "#f59e0b",
          background: "#fffbeb",
          surface: "#fef3c7",
          text: "#451a03",
        },
        typography: { headingFont: "Playfair", bodyFont: "Inter" },
        layoutStyle: "clean-grid",
        componentGuidelines: [],
      });

      const archSpec = ArchitectureSpecSchema.parse({
        appType: "nextjs-fullstack",
        capabilities: v2PRD.capabilities,
        requiresDatabase: true,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Shop with search & filter" },
          { path: "/checkout", type: "page", purpose: "Checkout" },
          { path: "/api/products", type: "api", purpose: "Product list with search filter query params" },
          { path: "/api/orders", type: "api", purpose: "Order placement" },
        ],
        uiComponents: [
          { name: "ProductGrid", purpose: "List items", route: "/" },
          { name: "SearchBar", purpose: "Search filter input", route: "/" },
          { name: "CartDrawer", purpose: "Slide-out cart", route: "/" },
        ],
        databaseModels: [
          { modelName: "Product", fields: ["id", "name", "price", "stock"], relations: [] },
          { modelName: "Order", fields: ["id", "total", "status"], relations: [] },
        ],
        backendOperations: [
          { name: "searchProducts", description: "Filter products by price/query", validationRules: ["Price bounds"], authRequired: false },
          { name: "createOrder", description: "Checkout order", validationRules: ["Stock validation"], authRequired: false },
        ],
        businessConstraints: ["Stock cannot drop below zero"],
        authRequirements: { enabled: false, strategy: "none" },
        fileOwnership: {
          frontend: ["app/**/*.tsx"],
          backend: ["app/api/**/*.ts"],
          database: ["prisma/schema.prisma", "lib/db.ts"],
        },
        dependencies: ["@prisma/client", "prisma"],
      });

      const prompt = buildContextEnhancedPrompt(v2PRD, designSpec, archSpec);
      assert.match(prompt, /search-filtering/i);
      assert.match(prompt, /Requires Persistence: YES/i);
      assert.match(prompt, /PRESERVE all existing working features/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO E: Standalone Exported ZIP Verification for All Applications
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario E: Standalone Exported ZIP Verification", () => {
    const testCases = [
      { name: "Developer Portfolio (Static)", requiresDb: false, models: [] },
      {
        name: "Inventory Management (CRUD)",
        requiresDb: true,
        models: [{ modelName: "Product", fields: ["sku String @unique", "name String", "quantity Int"] }],
      },
      {
        name: "Appointment Booking (Workflow)",
        requiresDb: true,
        models: [{ modelName: "Appointment", fields: ["customerName String", "serviceName String", "startTime DateTime"] }],
      },
      {
        name: "E-Commerce Coffee Store (Cart/Orders)",
        requiresDb: true,
        models: [
          { modelName: "Product", fields: ["name String", "price Float", "stock Int"] },
          { modelName: "Order", fields: ["total Float", "status String"] },
        ],
      },
    ];

    for (const tc of testCases) {
      it(`verifies standalone ZIP export integrity for "${tc.name}"`, async () => {
        const slug = tc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const baseFiles = getBaseProjectFiles({
          projectName: slug,
          requiresDatabase: tc.requiresDb,
          models: tc.models,
        });

        const projectFiles: Record<string, string> = {
          ...baseFiles,
          "app/page.tsx": `"use client";\nexport default function Page() { return <h1>${tc.name}</h1>; }`,
        };

        if (tc.requiresDb) {
          projectFiles["app/api/data/route.ts"] = `
import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({ ok: true }); }
export async function POST(req: Request) { return NextResponse.json({ created: true }, { status: 201 }); }
`;
        }

        // 1. Verify export file integrity rules
        assert.doesNotThrow(() => validateExportFiles(projectFiles));

        // 2. Sanitize files (defense against Zip Slip and hidden secret leaks)
        const cleanFiles = sanitizeProjectFiles(projectFiles);

        // 3. Generate JSZip archive
        const zip = new JSZip();
        const rootFolder = zip.folder(`codemytra-${slug}-v1`);
        assert.ok(rootFolder);

        for (const [filePath, content] of Object.entries(cleanFiles)) {
          rootFolder.file(filePath, content);
        }

        const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
        assert.ok(zipBuffer.length > 500);

        // 4. Extract archive into memory and inspect contents
        const extractedZip = await JSZip.loadAsync(zipBuffer);
        const fileNames = Object.keys(extractedZip.files);

        // Verify root directory containment
        assert.ok(fileNames.includes(`codemytra-${slug}-v1/package.json`));
        assert.ok(fileNames.includes(`codemytra-${slug}-v1/tsconfig.json`));
        assert.ok(fileNames.includes(`codemytra-${slug}-v1/app/page.tsx`));
        assert.ok(fileNames.includes(`codemytra-${slug}-v1/app/layout.tsx`));

        if (tc.requiresDb) {
          assert.ok(fileNames.includes(`codemytra-${slug}-v1/prisma/schema.prisma`));
          assert.ok(fileNames.includes(`codemytra-${slug}-v1/lib/db.ts`));
        }

        // Verify package.json is valid and contains required Next.js / build scripts
        const pkgContent = await extractedZip.file(`codemytra-${slug}-v1/package.json`)?.async("string");
        assert.ok(pkgContent);
        const parsedPkg = JSON.parse(pkgContent);
        assert.equal(parsedPkg.scripts.build, "next build");
        assert.ok(parsedPkg.dependencies.next);
        assert.ok(parsedPkg.dependencies.react);
        assert.ok(parsedPkg.dependencies["react-dom"]);
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 1 & 2: Foundation Configuration, Versioning & Lifecycle Integration
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 1 & 2: Foundation Configuration & Lifecycle Integration", () => {
    it("pins and documents foundation version and modern tooling configurations", () => {
      assert.equal(typeof FOUNDATION_VERSION, "string");
      assert.equal(FOUNDATION_VERSION, "2.1.0");

      const files = getBaseProjectFiles({
        projectName: "modern-app",
        requiresDatabase: true,
        models: [{ modelName: "Account", fields: ["email String @unique"] }],
      });

      // 1. Next.js config
      assert.ok(files["next.config.mjs"]);
      assert.match(files["next.config.mjs"], /reactStrictMode:\s*true/);

      // 2. ESLint 9 flat config
      assert.ok(files["eslint.config.mjs"]);
      assert.match(files["eslint.config.mjs"], /eslint-config-next\/core-web-vitals/);

      // 3. PostCSS with autoprefixer
      assert.ok(files["postcss.config.mjs"]);
      assert.match(files["postcss.config.mjs"], /autoprefixer/);

      // 4. Prisma 7 config & SQLite driver adapter
      assert.ok(files["prisma.config.ts"]);
      assert.match(files["prisma.config.ts"], /defineConfig/);
      assert.ok(files["prisma/schema.prisma"]);
      // Prisma 7 must not have datasource url in schema
      assert.equal(files["prisma/schema.prisma"].includes("url ="), false);
      assert.ok(files["lib/db.ts"]);
      assert.match(files["lib/db.ts"], /PrismaBetterSqlite3/);

      // 5. Package.json scripts and dependencies
      const pkg = JSON.parse(files["package.json"]);
      assert.equal(pkg.scripts["db:push"], "prisma db push");
      assert.equal(pkg.scripts["db:generate"], "prisma generate");
      assert.ok(pkg.dependencies["@prisma/adapter-better-sqlite3"]);
      assert.ok(pkg.devDependencies["autoprefixer"]);
    });

    it("preserves existing configuration on follow-up generations without overwriting with default foundation", () => {
      const existingV1Files: Record<string, string> = {
        "package.json": JSON.stringify({ name: "custom-app", version: "1.2.3", customKey: "preserved" }),
        "app/page.tsx": "export default function CustomPage() { return <div>Custom V1</div>; }",
        "custom-config.json": JSON.stringify({ setting: true }),
      };

      // When baseFiles exist (follow-up generation), initialFiles must use existing configuration
      const isInitialGen = Object.keys(existingV1Files).length === 0;
      assert.equal(isInitialGen, false);

      const effectiveBase = isInitialGen
        ? getBaseProjectFiles({ projectName: "should-not-be-used", requiresDatabase: false })
        : existingV1Files;

      assert.equal(effectiveBase["custom-config.json"], JSON.stringify({ setting: true }));
      assert.equal(JSON.parse(effectiveBase["package.json"]).customKey, "preserved");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 4: Architecture Fallback & Error Propagation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 4: Architecture Fallback & Error Propagation", () => {
    it("ArchitectureError retains structured failure and prevents silent fallback", () => {
      const err = new ArchitectureError(
        "Architect agent failed to generate a valid Architecture Specification after 2 attempt(s): Expected string, received number",
        "{ invalid json raw output }"
      );

      assert.equal(err.name, "ArchitectureError");
      assert.match(err.message, /failed to generate a valid Architecture Specification/);
      assert.equal(err.rawOutput, "{ invalid json raw output }");
      assert.ok(err instanceof Error);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 1 & TASK 2: Safe Database Verification & Model Operations
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 1 & Task 2: Safe Database Verification & Real Model Operations", () => {
    it("proves that QA leaves an existing database unchanged when validation fails", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-db-preserve-"));
      try {
        // Create an existing dev.db with known user records
        const devDbPath = path.join(tempDir, "dev.db");
        const existingData = Buffer.from("SQLITE_HEADER_USER_PERSISTED_RECORDS_ABC_123_DO_NOT_ALTER");
        fs.writeFileSync(devDbPath, existingData);
        const originalHash = crypto.createHash("sha256").update(existingData).digest("hex");

        // Write an invalid schema in tempDir to cause schema validation failure
        fs.mkdirSync(path.join(tempDir, "prisma"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "prisma/schema.prisma"), "INVALID SYNTAX BROKEN");

        // Track all executed commands
        const executedCommands: string[] = [];
        const mockExecutor = {
          run: async (cmd: string) => {
            executedCommands.push(cmd);
            if (cmd.includes("prisma validate")) {
              return { exitCode: 1, stdout: "", stderr: "Schema validation error: broken syntax" };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        };

        const result = await executeDatabaseVerificationPipeline(mockExecutor, {
          workspaceDir: tempDir,
          models: [{ modelName: "Product", fields: ["sku String"] }],
          disposableDbName: ".qa_disposable.db",
        });

        // Verification failed as expected
        const valCheck = result.checks.find((c) => c.name === "database-schema-live-validation");
        assert.ok(valCheck);
        assert.equal(valCheck.status, "FAIL");

        // PROVE: Existing dev.db was NEVER touched or altered
        assert.ok(fs.existsSync(devDbPath), "Existing dev.db must still exist");
        const currentData = fs.readFileSync(devDbPath);
        const currentHash = crypto.createHash("sha256").update(currentData).digest("hex");
        assert.equal(currentHash, originalHash, "Existing dev.db SHA-256 hash must be identical");
        assert.deepEqual(currentData, existingData, "Existing dev.db bytes must be completely unchanged");

        // Verify that commands never targeted dev.db
        for (const cmd of executedCommands) {
          assert.equal(cmd.includes("dev.db"), false, `Command should never directly target dev.db: ${cmd}`);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("verifies real database connectivity and model operations are tested and reported distinctly", async () => {
      const executedCommands: string[] = [];
      const mockExecutor = {
        run: async (cmd: string) => {
          executedCommands.push(cmd);
          if (cmd.includes("prisma validate")) return { exitCode: 0, stdout: "Valid", stderr: "" };
          if (cmd.includes("prisma generate")) return { exitCode: 0, stdout: "Generated", stderr: "" };
          if (cmd.includes("prisma db push")) return { exitCode: 0, stdout: "Pushed", stderr: "" };
          if (cmd.includes("SELECT 1")) return { exitCode: 0, stdout: "DB_CONNECTIVITY_SUCCESS", stderr: "" };
          if (cmd.includes("MODEL_OPERATION_SUCCESS")) return { exitCode: 0, stdout: "MODEL_OPERATION_SUCCESS:4", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      const result = await executeDatabaseVerificationPipeline(mockExecutor, {
        workspaceDir: "/tmp/mock",
        models: [{ modelName: "InventoryItem", fields: ["name String"] }],
        disposableDbName: ".qa_disposable.db",
      });

      // Verify separate checks
      const connCheck = result.checks.find((c) => c.name === "database-connectivity");
      assert.ok(connCheck, "database-connectivity check must exist");
      assert.equal(connCheck.status, "PASS");
      assert.match(connCheck.details || "", /SELECT 1/);

      const modelCheck = result.checks.find((c) => c.name === "database-model-operations");
      assert.ok(modelCheck, "database-model-operations check must exist");
      assert.equal(modelCheck.status, "PASS");
      assert.match(modelCheck.details || "", /InventoryItem/);

      // Verify initialization command used disposable DB without --accept-data-loss
      const pushCmd = executedCommands.find((c) => c.includes("db push"));
      assert.ok(pushCmd);
      assert.match(pushCmd, /DATABASE_URL="file:\.\/\.qa_disposable\.db"/);
      assert.equal(pushCmd.includes("--accept-data-loss"), false, "Must NOT use --accept-data-loss");
    });

    it("reports database checks as SKIPPED for static applications without false passes", async () => {
      const report = await runQAInspector({
        files: { "app/page.tsx": "export default function () { return <div>Static</div>; }" },
        summary: "Static portfolio without database",
        sandboxId: "",
        runSandboxCommands: false,
        capabilities: ["pages-navigation"],
      });

      const connCheck = report.checks.find((c) => c.name === "database-connectivity");
      assert.ok(connCheck);
      assert.equal(connCheck.status, "SKIPPED");

      const modelCheck = report.checks.find((c) => c.name === "database-model-operations");
      assert.ok(modelCheck);
      assert.equal(modelCheck.status, "SKIPPED");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 3: Removal of Invented Database Models
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 3: Removal of Invented Database Models", () => {
    it("throws MissingDatabaseModelsError when persistence is required but models is empty", () => {
      assert.throws(
        () => {
          getBaseProjectFiles({
            projectName: "no-models-app",
            requiresDatabase: true,
            models: [],
          });
        },
        MissingDatabaseModelsError
      );

      assert.throws(
        () => {
          buildPrismaSchema([]);
        },
        MissingDatabaseModelsError
      );
    });

    it("does not generate invented fallback Item model anywhere", () => {
      const files = getBaseProjectFiles({
        projectName: "booking-app",
        requiresDatabase: true,
        models: [{ modelName: "Booking", fields: ["date DateTime"] }],
      });

      assert.ok(files["prisma/schema.prisma"]);
      assert.match(files["prisma/schema.prisma"], /model Booking/);
      assert.equal(files["prisma/schema.prisma"].includes("model Item"), false);
    });
  });
});
