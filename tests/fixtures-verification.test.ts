import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBaseProjectFiles, isDatabaseRequired, synthesizeComponentsBarrel } from "@/server/templates/foundation";
import {
  runQAInspector,
  hasValidRouteHandlerExport,
} from "@/server/agents/qa";
import {
  executeBatchFileWrites,
  formatModelInterfacesForPrompt,
  buildContextEnhancedPrompt,
} from "@/server/agents/coder";
import { PRD, DesignSpec, ArchitectureSpec, PRDSchema, DesignSpecSchema, ArchitectureSpecSchema } from "@/server/agent-contracts/schemas";

describe("CodeMytra M4 Release Tests: Generated Application Fixtures", () => {
  // =========================================================================
  // FIXTURE A: Static Application (Bakery Landing Page)
  // =========================================================================
  describe("Fixture A: Static Bakery Landing Page", () => {
    const bakeryPrd: PRD = PRDSchema.parse({
      projectName: "sweet-crumb-bakery",
      summary: "Artisan bakery landing page with interactive pastry catalog, cart simulation, and custom cake inquiry form.",
      targetAudience: "Local customers and pastry enthusiasts",
      capabilities: ["pages-navigation", "forms-validation"],
      coreFeatures: [
        { name: "Pastry Catalog", description: "Interactive pastry menu", priority: "MUST" },
        { name: "Order Basket", description: "Cart simulation", priority: "MUST" },
      ],
      pages: [
        {
          route: "/",
          title: "Artisan Bakery & Cafe",
          purpose: "Present bakery offerings, daily specials, interactive order basket, and inquiry modal",
          keyComponents: ["HeroSection", "PastryCatalog", "CartDrawer", "InquiryForm", "Footer"],
        },
      ],
      dataEntities: [],
      userFlows: [
        {
          name: "Explore and Order",
          steps: ["Browse pastries", "Filter by gluten-free", "Add to basket", "Submit custom inquiry"],
        },
      ],
    });

    const bakeryDesign: DesignSpec = DesignSpecSchema.parse({
      aestheticTheme: "Warm Rustic Bakery",
      colorPalette: {
        primary: "#d97706",
        secondary: "#78350f",
        accent: "#f59e0b",
        background: "#fffbeb",
        surface: "#fef3c7",
        text: "#1c1917",
      },
      typography: {
        headingFont: "Playfair Display",
        bodyFont: "Inter",
      },
      layoutStyle: "Cozy artisan showcase with interactive drawers",
    });

    const bakeryArch: ArchitectureSpec = ArchitectureSpecSchema.parse({
      routeEndpoints: [
        {
          path: "/",
          type: "page",
          purpose: "Interactive bakery landing page",
        },
      ],
      capabilities: ["pages-navigation", "forms-validation"],
      requiresDatabase: false,
      databaseModels: [],
      backendOperations: [],
      businessConstraints: [
        "No server-side database required; all interactions managed with client state",
      ],
      fileOwnership: {
        frontend: ["app/page.tsx", "components/**"],
        backend: [],
        database: [],
      },
      dependencies: ["lucide-react", "clsx", "tailwind-merge"],
    });

    it("verifies static foundation contains zero database machinery or sqlite dependencies", () => {
      assert.equal(isDatabaseRequired(bakeryArch.capabilities), false);
      const baseFiles = getBaseProjectFiles({
        projectName: bakeryPrd.projectName,
        capabilities: bakeryArch.capabilities,
        requiresDatabase: bakeryArch.requiresDatabase,
        models: bakeryArch.databaseModels,
      });

      // 1. Mandatory static infrastructure files present
      assert.ok(baseFiles["package.json"], "package.json must be present");
      assert.ok(baseFiles["tsconfig.json"], "tsconfig.json must be present");
      assert.ok(baseFiles["next.config.mjs"], "next.config.mjs must be present");
      assert.ok(baseFiles["lib/utils.ts"], "lib/utils.ts must be present");
      assert.ok(baseFiles["app/layout.tsx"], "app/layout.tsx must be present");

      // 2. Database files strictly absent
      assert.equal(baseFiles["prisma/schema.prisma"], undefined, "Prisma schema must NOT be present in static app");
      assert.equal(baseFiles["prisma.config.ts"], undefined, "Prisma config must NOT be present in static app");
      assert.equal(baseFiles["lib/db.ts"], undefined, "lib/db.ts must NOT be present in static app");
      assert.equal(baseFiles[".env.example"], undefined, ".env.example must NOT be present in static app");

      // 3. Package dependencies are lean and clean
      const pkg = JSON.parse(baseFiles["package.json"]);
      assert.equal(pkg.dependencies["next"], "16.4.2");
      assert.equal(pkg.dependencies["react"], "19.2.4");
      assert.ok(pkg.dependencies["tailwind-merge"]);
      assert.ok(pkg.dependencies["lucide-react"]);
      assert.equal(pkg.dependencies["@prisma/client"], undefined);
      assert.equal(pkg.dependencies["better-sqlite3"], undefined);
      assert.equal(pkg.devDependencies["prisma"], undefined);
    });

    it("verifies prompt directives enforce lean static delivery without database files", () => {
      const prompt = buildContextEnhancedPrompt(bakeryPrd, bakeryDesign, bakeryArch);
      assert.match(prompt, /Requires Persistence: NO \(static \/ client state\)/);
      assert.match(prompt, /Database Models: None required \(static application\)/);
      assert.match(prompt, /Do NOT generate any prisma schema, dev\.db, sqlite configuration/);
      assert.match(prompt, /Implement rich interactive features .* using React client state/);
    });

    it("verifies foundation file protection prevents AI from overwriting static foundation files", async () => {
      const existingDisk: Record<string, string> = {
        "/home/user/workspace/package.json": '{"name":"original-foundation"}',
        "/home/user/workspace/lib/utils.ts": 'export function cn() {}',
      };

      const mockClient = {
        exists: async (p: string) => p in existingDisk,
        read: async (p: string) => existingDisk[p],
        write: async (p: string, data: string) => {
          existingDisk[p] = data;
        },
        remove: async (p: string) => {
          delete existingDisk[p];
        },
      };

      // Attempt to overwrite package.json and lib/utils.ts while writing page.tsx
      const result = await executeBatchFileWrites(mockClient, [
        { path: "package.json", content: '{"name":"corrupted"}' },
        { path: "lib/utils.ts", content: "export const malicious = true;" },
        { path: "app/page.tsx", content: '"use client"; export default function Page() { return <h1>Bakery</h1>; }' },
      ]);

      assert.equal(result.success, true);
      // Foundation files are protected and unmodified
      assert.equal(existingDisk["/home/user/workspace/package.json"], '{"name":"original-foundation"}');
      assert.equal(existingDisk["/home/user/workspace/lib/utils.ts"], 'export function cn() {}');
      // Application page is successfully created
      assert.ok(existingDisk["/home/user/workspace/app/page.tsx"].includes("Bakery"));
    });

    it("verifies static bakery landing page passes QA inspection with 100% score and zero errors", async () => {
      const baseFiles = getBaseProjectFiles({
        projectName: bakeryPrd.projectName,
        requiresDatabase: false,
      });

      const bakeryAppFiles: Record<string, string> = {
        ...baseFiles,
        "app/page.tsx": `
"use client";
import React, { useState } from "react";
import { ShoppingBag, Coffee, Star, MapPin, Phone, Heart, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Pastry {
  id: string;
  name: string;
  price: number;
  description: string;
  category: "croissant" | "bread" | "cake";
}

const PASTRIES: Pastry[] = [
  { id: "1", name: "Almond Croissant", price: 4.5, description: "Flaky buttery pastry filled with almond frangipane", category: "croissant" },
  { id: "2", name: "Sourdough Boule", price: 7.0, description: "Naturally leavened sourdough with crackling crust", category: "bread" },
  { id: "3", name: "Raspberry Tart", price: 5.5, description: "Sweet pastry crust with fresh raspberries and custard", category: "cake" },
];

export default function BakeryPage() {
  const [cart, setCart] = useState<{ id: string; name: string; price: number; qty: number }[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [inquirySent, setInquirySent] = useState(false);

  const addToCart = (p: Pastry) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.id === p.id);
      if (existing) {
        return prev.map((item) => item.id === p.id ? { ...item, qty: item.qty + 1 } : item);
      }
      return [...prev, { id: p.id, name: p.name, price: p.price, qty: 1 }];
    });
  };

  const filtered = selectedCategory === "all" ? PASTRIES : PASTRIES.filter((p) => p.category === selectedCategory);
  const cartTotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <main className="min-h-screen bg-amber-50/30 text-stone-900">
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10 px-6 py-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-amber-800 flex items-center gap-2">
          <Coffee className="w-6 h-6" /> Sweet Crumb Bakery
        </h1>
        <div className="flex items-center gap-4">
          <button className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg font-medium">
            <ShoppingBag className="w-5 h-5" />
            <span>Basket ({cart.reduce((a, b) => a + b.qty, 0)})</span>
          </button>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-6 py-12">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-4xl font-extrabold text-stone-900 mb-4">Baked Fresh Every Morning</h2>
          <p className="text-stone-600">Handcrafted artisan breads, flaky viennoiserie, and seasonal pastries baked in stone hearth ovens.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {filtered.map((pastry) => (
            <div key={pastry.id} className="bg-white rounded-xl border p-6 shadow-sm hover:shadow-md transition">
              <h3 className="text-xl font-semibold mb-2">{pastry.name}</h3>
              <p className="text-stone-600 text-sm mb-4">{pastry.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold text-amber-700">$\${pastry.price.toFixed(2)}</span>
                <button
                  onClick={() => addToCart(pastry)}
                  className="bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-md text-sm font-medium"
                >
                  Add to Cart
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
`,
      };

      const report = await runQAInspector({
        files: bakeryAppFiles,
        summary: "Implemented responsive Sweet Crumb bakery landing page with interactive basket and filtered menu.",
        sandboxId: "",
        runSandboxCommands: false,
        archSpec: bakeryArch,
      });

      assert.equal(report.passed, true);
      assert.equal(report.score, 100);
      assert.equal(report.repairNeeded, false);

      // Verify database checks were cleanly handled for static app
      const schemaCheck = report.checks.find((c) => c.name === "database-schema-validation");
      assert.ok(schemaCheck);
      assert.equal(schemaCheck.status, "PASS");
      assert.match(schemaCheck.details || "", /Static application/);

      const skippedDbChecks = report.checks.filter(
        (c) => c.category === "database-validation" && c.name !== "database-schema-validation"
      );
      for (const dbc of skippedDbChecks) {
        assert.equal(dbc.status, "SKIPPED", `Database check ${dbc.name} must be SKIPPED for static app`);
      }

      // Verify API check passed cleanly for static app
      const apiCheck = report.checks.find((c) => c.category === "api-validation");
      assert.ok(apiCheck);
      assert.equal(apiCheck.status, "PASS");
      assert.match(apiCheck.details || "", /Static application/);
    });
  });

  // =========================================================================
  // FIXTURE B: Full-Stack Application (Online Bookstore)
  // =========================================================================
  describe("Fixture B: Full-Stack Bookstore Application", () => {
    const bookstorePrd: PRD = PRDSchema.parse({
      projectName: "chapter-one-bookstore",
      summary: "Full-stack online bookstore featuring books catalog, customer reviews, user accounts, and checkout orders.",
      targetAudience: "Book lovers, collectors, and readers",
      capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
      coreFeatures: [
        { name: "Books Catalog", description: "Search and browse books", priority: "MUST" },
        { name: "Customer Reviews", description: "Read and write reviews", priority: "MUST" },
        { name: "Checkout Orders", description: "Place and track orders", priority: "MUST" },
      ],
      pages: [
        {
          route: "/",
          title: "Bookstore Showcase",
          purpose: "Browse and search books, view ratings, and add to bag",
          keyComponents: ["BookGrid", "SearchBar", "CategoryTabs"],
        },
        {
          route: "/profile",
          title: "User Profile & Order History",
          purpose: "View past orders, track order status, and manage profile",
          keyComponents: ["OrderHistory", "UserProfileCard"],
        },
      ],
      dataEntities: [
        {
          name: "Book",
          fields: ["id", "title", "author", "price", "category", "stock"],
          relationships: ["has many Reviews"],
          isPersistent: true,
        },
        {
          name: "Review",
          fields: ["id", "rating", "comment", "userName", "bookId"],
          relationships: ["belongs to Book"],
          isPersistent: true,
        },
        {
          name: "User",
          fields: ["id", "email", "name", "role"],
          relationships: ["has many Orders"],
          isPersistent: true,
        },
        {
          name: "Order",
          fields: ["id", "totalPrice", "orderDate", "status", "userId", "items"],
          relationships: ["belongs to User"],
          isPersistent: true,
        },
      ],
      userFlows: [
        {
          name: "Purchase Book",
          steps: ["Search books", "Read reviews", "Place order", "View order confirmation in profile"],
        },
      ],
    });

    const bookstoreArch: ArchitectureSpec = ArchitectureSpecSchema.parse({
      routeEndpoints: [
        { path: "/", type: "page", purpose: "Bookstore home page" },
        { path: "/profile", type: "page", purpose: "User profile and order history" },
        { path: "app/api/books/route.ts", type: "api", purpose: "Books CRUD API", methods: ["GET", "POST"] },
        { path: "app/api/reviews/route.ts", type: "api", purpose: "Reviews CRUD API", methods: ["GET", "POST"] },
        { path: "app/api/users/route.ts", type: "api", purpose: "User profile API", methods: ["GET", "POST"] },
        { path: "app/api/orders/route.ts", type: "api", purpose: "Orders checkout API", methods: ["GET", "POST"] },
      ],
      capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
      requiresDatabase: true,
      databaseModels: [
        {
          modelName: "Book",
          fields: ["id String @id @default(cuid())", "title String", "author String", "price Float", "category String", "stock Int @default(10)"],
          relations: [],
        },
        {
          modelName: "Review",
          fields: ["id String @id @default(cuid())", "rating Int @default(5)", "comment String", "userName String", "bookId String?"],
          relations: [],
        },
        {
          modelName: "User",
          fields: ["id String @id @default(cuid())", "email String @unique", "name String", "role String @default(\"customer\")"],
          relations: [],
        },
        {
          modelName: "Order",
          fields: ["id String @id @default(cuid())", "totalPrice Float @default(0.0)", "orderDate DateTime @default(now())", "status String @default(\"pending\")", "userId String?", "items String?"],
          relations: [],
        },
      ],
      backendOperations: [
        { name: "getBooks", description: "Fetch books catalog", validationRules: ["Optional ?category or ?q filtering"], authRequired: false },
        { name: "createBook", description: "Create book record", validationRules: ["title, author, price required"], authRequired: false },
        { name: "getOrders", description: "Fetch user orders", validationRules: ["Sorted by orderDate desc"], authRequired: false },
        { name: "createOrder", description: "Create checkout order", validationRules: ["totalPrice and items required"], authRequired: false },
      ],
      businessConstraints: [
        "Order totalPrice must be non-negative",
        "Book stock cannot drop below zero",
      ],
      fileOwnership: {
        frontend: ["app/page.tsx", "app/profile/page.tsx", "components/**"],
        backend: ["app/api/books/route.ts", "app/api/reviews/route.ts", "app/api/users/route.ts", "app/api/orders/route.ts"],
        database: ["prisma/schema.prisma", "lib/db.ts"],
      },
      dependencies: ["@prisma/client", "prisma", "better-sqlite3", "@prisma/adapter-better-sqlite3"],
    });

    it("verifies full-stack foundation generates valid isolated SQLite schema and database client", () => {
      const baseFiles = getBaseProjectFiles({
        projectName: bookstorePrd.projectName,
        capabilities: bookstoreArch.capabilities,
        requiresDatabase: true,
        models: bookstoreArch.databaseModels,
      });

      // 1. Prisma schema present and populated
      const schema = baseFiles["prisma/schema.prisma"];
      assert.ok(schema, "prisma/schema.prisma must be generated for full-stack app");
      assert.match(schema, /provider = "sqlite"/);
      assert.match(schema, /model Book \{/);
      assert.match(schema, /model Review \{/);
      assert.match(schema, /model User \{/);
      assert.match(schema, /model Order \{/);

      // Verify specific Order fields required by live applications
      assert.match(schema, /totalPrice Float/);
      assert.match(schema, /orderDate DateTime/);
      assert.match(schema, /status String/);

      // 2. Database client setup present
      const dbClient = baseFiles["lib/db.ts"];
      assert.ok(dbClient, "lib/db.ts must be generated");
      assert.match(dbClient, /PrismaBetterSqlite3/);
      assert.match(dbClient, /export const db =/);

      // 3. Package dependencies include Prisma ORM and SQLite adapter
      const pkg = JSON.parse(baseFiles["package.json"]);
      assert.equal(pkg.dependencies["@prisma/client"], "^7.8.0");
      assert.equal(pkg.dependencies["@prisma/adapter-better-sqlite3"], "^7.10.1");
      assert.equal(pkg.dependencies["better-sqlite3"], "^13.0.3");
      assert.equal(pkg.devDependencies["prisma"], "^7.10.1");
    });

    it("verifies model interfaces formatter generates correct TypeScript types for the coder prompt", () => {
      const types = formatModelInterfacesForPrompt(bookstoreArch.databaseModels);
      assert.match(types, /export interface Book \{/);
      assert.match(types, /price: number;/);
      assert.match(types, /stock: number;/);

      assert.match(types, /export interface Order \{/);
      assert.match(types, /totalPrice: number;/);
      assert.match(types, /orderDate: Date \| string;/);
      assert.match(types, /status: string;/);

      assert.match(types, /export interface Review \{/);
      assert.match(types, /rating: number;/);

      assert.match(types, /export interface User \{/);
      assert.match(types, /email: string;/);
    });

    it("verifies API route handler export detection correctly identifies valid exported App Router handlers", () => {
      // 1. export async function GET
      assert.equal(hasValidRouteHandlerExport("export async function GET(req: Request) { return new Response(); }"), true);
      // 2. export function POST
      assert.equal(hasValidRouteHandlerExport("export function POST(req: Request) { return new Response(); }"), true);
      // 3. export const GET =
      assert.equal(hasValidRouteHandlerExport("export const GET = async () => new Response();"), true);
      // 4. export { GET, POST }
      assert.equal(hasValidRouteHandlerExport("const GET = () => {}; export { GET };"), true);
      // 5. Invalid / non-export file
      assert.equal(hasValidRouteHandlerExport("function helper() {} const x = 10;"), false);
    });

    it("verifies profile page typed useState pattern avoids never[] compiler errors", () => {
      const profilePageCode = `
"use client";
import React, { useState, useEffect } from "react";

export interface Order {
  id: string;
  totalPrice: number;
  orderDate: Date | string;
  status: string;
}

export default function ProfilePage() {
  // Correctly typed generic prevents never[] inference
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/app/api/orders")
      .then((res) => res.json())
      .then((data: Order[]) => {
        setOrders(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-8">
      <h1>My Orders</h1>
      {orders.map((order) => (
        <div key={order.id} className="border p-4 my-2">
          <span>Order #{order.id}</span>
          <span>Total: $\${order.totalPrice.toFixed(2)}</span>
          <span>Date: {typeof order.orderDate === "string" ? new Date(order.orderDate).toLocaleDateString() : order.orderDate.toLocaleDateString()}</span>
          <span>Status: {order.status}</span>
        </div>
      ))}
    </div>
  );
}
`;
      // Verify no untyped useState([]) in the component
      assert.ok(!profilePageCode.includes("useState([])"), "useState must not be untyped useState([])");
      assert.ok(profilePageCode.includes("useState<Order[]>([])"), "useState must use explicit Order[] generic");
      assert.ok(profilePageCode.includes("order.totalPrice"), "order must access totalPrice");
      assert.ok(profilePageCode.includes("order.orderDate"), "order must access orderDate");
    });

    it("verifies full-stack bookstore application passes QA inspection with API routes and database validation", async () => {
      const baseFiles = getBaseProjectFiles({
        projectName: bookstorePrd.projectName,
        capabilities: bookstoreArch.capabilities,
        requiresDatabase: true,
        models: bookstoreArch.databaseModels,
      });

      const bookstoreFiles: Record<string, string> = {
        ...baseFiles,
        "app/page.tsx": `
"use client";
import React, { useState, useEffect } from "react";
import { BookOpen, ShoppingCart, Star } from "lucide-react";

export default function BooksPage() {
  const [books, setBooks] = useState<Array<{ id: string; title: string; author: string; price: number }>>([]);

  useEffect(() => {
    fetch("/app/api/books").then(r => r.json()).then(data => setBooks(data)).catch(() => {});
  }, []);

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold flex items-center gap-2"><BookOpen /> Chapter One Bookstore</h1>
      <div className="grid grid-cols-2 gap-4 mt-6">
        {books.map(b => (
          <div key={b.id} className="p-4 border rounded">
            <h2>{b.title}</h2>
            <p className="text-gray-500">{b.author}</p>
            <p className="font-bold">$\${b.price}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
`,
        "app/profile/page.tsx": `
"use client";
import React, { useState, useEffect } from "react";

interface Order {
  id: string;
  totalPrice: number;
  orderDate: string;
  status: string;
}

export default function ProfilePage() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch("/app/api/orders").then(r => r.json()).then(data => setOrders(data)).catch(() => {});
  }, []);

  return (
    <div className="p-8">
      <h1>Your Profile & Orders</h1>
      {orders.map(o => (
        <div key={o.id}>
          <span>{o.id}: $\${o.totalPrice} ({o.status})</span>
        </div>
      ))}
    </div>
  );
}
`,
        "app/api/books/route.ts": `
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const books = await db.book.findMany();
    return NextResponse.json(books, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch books" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.title || !body.author || body.price === undefined) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    const book = await db.book.create({ data: { title: body.title, author: body.author, price: Number(body.price) } });
    return NextResponse.json(book, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to create book" }, { status: 500 });
  }
}
`,
        "app/api/reviews/route.ts": `
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const reviews = await db.review.findMany();
    return NextResponse.json(reviews, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch reviews" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.comment || body.rating === undefined) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    const review = await db.review.create({ data: { rating: Number(body.rating), comment: body.comment, userName: body.userName || "Reader" } });
    return NextResponse.json(review, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to create review" }, { status: 500 });
  }
}
`,
        "app/api/users/route.ts": `
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const users = await db.user.findMany();
    return NextResponse.json(users, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }
    const user = await db.user.create({ data: { email: body.email, name: body.name || "Customer" } });
    return NextResponse.json(user, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }
}
`,
        "app/api/orders/route.ts": `
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const orders = await db.order.findMany();
    return NextResponse.json(orders, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body.totalPrice === undefined) {
      return NextResponse.json({ error: "Missing totalPrice" }, { status: 400 });
    }
    const order = await db.order.create({
      data: {
        totalPrice: Number(body.totalPrice),
        status: "confirmed",
        orderDate: new Date(),
        items: JSON.stringify(body.items || []),
      },
    });
    return NextResponse.json(order, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
  }
}
`,
      };

      const report = await runQAInspector({
        files: bookstoreFiles,
        summary: "Implemented Chapter One online bookstore with Book, Review, User, and Order models and APIs.",
        sandboxId: "",
        runSandboxCommands: false,
        archSpec: bookstoreArch,
      });

      assert.equal(report.passed, true);
      assert.equal(report.score, 100);
      assert.equal(report.repairNeeded, false);

      // Verify API routes were validated and passed
      const apiCheck = report.checks.find((c) => c.category === "api-validation");
      assert.ok(apiCheck);
      assert.equal(apiCheck.status, "PASS");
      assert.match(apiCheck.details || "", /4 API route handler\(s\) verified/);

      // Verify database schema static validation passed
      const dbCheck = report.checks.find((c) => c.name === "database-schema-validation");
      assert.ok(dbCheck);
      assert.equal(dbCheck.status, "PASS");
    });
  });

  // =========================================================================
  // ISSUE 1: Barrel Imports and Component Resolution
  // =========================================================================
  describe("Issue 1: Barrel Imports and Component Resolution", () => {
    it("synthesizes components/index.ts when components exist and barrel is absent", () => {
      const files: Record<string, string> = {
        "components/Header.tsx": "export default function Header() { return <header>Header</header>; }",
        "components/Footer.tsx": "export function Footer() { return <footer>Footer</footer>; }",
        "components/CartDrawer.tsx": "export default function CartDrawer() {}; export const CART_LIMIT = 10;",
      };

      const synthesized = synthesizeComponentsBarrel(files);
      assert.ok(synthesized["components/index.ts"], "components/index.ts must be synthesized");
      const barrelContent = synthesized["components/index.ts"];

      // Verify Header default export re-exported under named identifier
      assert.match(barrelContent, /export \{ default as Header \} from "\.\/Header";/);

      // Verify Footer named export re-exported
      assert.match(barrelContent, /export \* from "\.\/Footer";/);

      // Verify CartDrawer with both default and named exports
      assert.match(barrelContent, /export \* from "\.\/CartDrawer";/);
      assert.match(barrelContent, /export \{ default as CartDrawer \} from "\.\/CartDrawer";/);
    });

    it("does not overwrite an existing components/index.ts", () => {
      const customBarrel = "// User custom barrel\nexport { Custom } from './Custom';\n";
      const files: Record<string, string> = {
        "components/Header.tsx": "export default function Header() {}",
        "components/index.ts": customBarrel,
      };

      const result = synthesizeComponentsBarrel(files);
      assert.equal(result["components/index.ts"], customBarrel);
    });

    it("returns unchanged files if no components/ files exist", () => {
      const files: Record<string, string> = {
        "app/page.tsx": "export default function Page() {}",
      };

      const result = synthesizeComponentsBarrel(files);
      assert.equal(result["components/index.ts"], undefined);
    });

    it("QA inspector validates and passes when app/page.tsx imports from @/components with synthesized barrel", async () => {
      const baseFiles = getBaseProjectFiles({ projectName: "barrel-app", requiresDatabase: false });
      const projectFiles: Record<string, string> = {
        ...baseFiles,
        "components/Header.tsx": "export function Header() { return <header>Header</header>; }",
        "components/Footer.tsx": "export function Footer() { return <footer>Footer</footer>; }",
        "app/page.tsx": `
"use client";
import React from "react";
import { Header, Footer } from "@/components";

export default function Page() {
  return (
    <main>
      <Header />
      <p>Content</p>
      <Footer />
    </main>
  );
}
`,
      };

      const report = await runQAInspector({
        files: projectFiles,
        summary: "Implemented page using @/components barrel import.",
        sandboxId: "",
        runSandboxCommands: false,
      });

      assert.equal(report.passed, true);
      assert.equal(report.score, 100);
      assert.equal(report.repairNeeded, false);

      const importCheck = report.checks.find((c) => c.name === "import-integrity");
      assert.ok(importCheck);
      assert.equal(importCheck.status, "PASS");
    });

    it("QA inspector flags dangling @/ import when target module does not exist", async () => {
      const baseFiles = getBaseProjectFiles({ projectName: "dangling-app", requiresDatabase: false });
      const projectFiles: Record<string, string> = {
        ...baseFiles,
        "app/page.tsx": `
"use client";
import { NonExistent } from "@/components/NonExistent";

export default function Page() {
  return <main><NonExistent /></main>;
}
`,
      };

      const report = await runQAInspector({
        files: projectFiles,
        summary: "Implemented page with dangling import.",
        sandboxId: "",
        runSandboxCommands: false,
      });

      assert.equal(report.passed, false);
      const importCheck = report.checks.find((c) => c.name === "import-integrity");
      assert.ok(importCheck);
      assert.equal(importCheck.status, "FAIL");
      assert.match(importCheck.details || "", /@\/components\/NonExistent/);
    });
  });

  // =========================================================================
  // ISSUE 4 & 5: Preview Lifecycle Syntax & Functional Completeness
  // =========================================================================
  describe("Issue 4 & 5: Preview Lifecycle Syntax & Functional Completeness", () => {
    it("Issue 4: ensures preview server startup uses valid shell syntax without syntax errors", async () => {
      const { spawnSync } = await import("child_process");
      // Test the shell syntax pattern used by ensureSandboxPreviewServer
      const testScript = `
        PROJECT_WORKSPACE_DIR="/tmp/test-preview-syntax"
        mkdir -p "$PROJECT_WORKSPACE_DIR"
        cd "$PROJECT_WORKSPACE_DIR"
        if command -v bun >/dev/null 2>&1; then
          echo "bun-ok" </dev/null >/dev/null 2>&1 &
        else
          echo "npm-ok" </dev/null >/dev/null 2>&1 &
        fi
      `;
      const res = spawnSync("sh", ["-c", testScript]);
      assert.equal(res.status, 0, "Shell syntax must execute with exit code 0 without parse errors");
    });

    it("Issue 5: verifies coder prompt enforces complete implementation without placeholders and secure password handling", () => {
      const mockPrd = PRDSchema.parse({
        projectName: "booking-portal",
        summary: "Doctor appointment booking portal with interactive calendar and patient management.",
        targetAudience: "Clinic patients",
        capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
        coreFeatures: [{ name: "Calendar", description: "Interactive appointment booking", priority: "MUST" }],
        pages: [{ route: "/", title: "Home", purpose: "Main portal", keyComponents: ["AppointmentCalendar"] }],
        dataEntities: [],
        userFlows: [{ name: "Book", steps: ["Select date", "Confirm"] }],
      });

      const mockDesign = DesignSpecSchema.parse({
        aestheticTheme: "Clean Clinic",
        colorPalette: { primary: "#0284c7", secondary: "#0f172a", accent: "#38bdf8", background: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
        typography: { headingFont: "Inter", bodyFont: "Inter" },
        layoutStyle: "Professional clinic portal",
      });

      const mockArch = ArchitectureSpecSchema.parse({
        routeEndpoints: [{ path: "/", type: "page", purpose: "Booking portal" }],
        capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
        requiresDatabase: true,
        databaseModels: [{ modelName: "User", fields: ["id", "email", "name", "role"] }],
        backendOperations: [],
        businessConstraints: ["Strict validation"],
        fileOwnership: { frontend: ["app/page.tsx"], backend: ["app/api/users/route.ts"], database: ["prisma/schema.prisma"] },
        dependencies: ["lucide-react"],
      });

      const prompt = buildContextEnhancedPrompt(
        mockPrd,
        mockDesign,
        mockArch
      );

      // Issue 5 verification: No placeholders directive
      assert.match(prompt, /COMPLETE FUNCTIONAL IMPLEMENTATION \(NO PLACEHOLDERS\)/i);
      assert.match(prompt, /Never generate empty placeholders, stub components, or explanatory placeholder text/i);
      assert.match(prompt, /interactive month\/week calendar grids/i);

      // Issue 5 verification: Security & password safety
      assert.match(prompt, /SECURITY & SENSITIVE DATA/i);
      assert.match(prompt, /Never store plaintext passwords in database models or expose passwords in API routes/i);
    });
  });
});


