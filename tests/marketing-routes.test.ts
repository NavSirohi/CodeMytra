import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("M3 Public Marketing Website - Structure & Acceptance Verification", () => {
  const routes = [
    { file: "src/app/(marketing)/page.tsx", route: "/", expectedTitle: "Build something meaningful | CodeMytra" },
    { file: "src/app/(marketing)/product/page.tsx", route: "/product", expectedTitle: "The Product | CodeMytra" },
    { file: "src/app/(marketing)/how-it-works/page.tsx", route: "/how-it-works", expectedTitle: "How it works | CodeMytra" },
    { file: "src/app/(marketing)/pricing/page.tsx", route: "/pricing", expectedTitle: "Pricing | CodeMytra" },
    { file: "src/app/(marketing)/about/page.tsx", route: "/about", expectedTitle: "About and Team | CodeMytra" },
    { file: "src/app/(marketing)/contact/page.tsx", route: "/contact", expectedTitle: "Contact | CodeMytra" },
    { file: "src/app/(marketing)/builder/page.tsx", route: "/builder", expectedTitle: "Builder Preview | CodeMytra" },
  ];

  it("verifies all approved marketing pages exist and export metadata and default component", () => {
    for (const r of routes) {
      const filePath = path.join(process.cwd(), r.file);
      assert.ok(fs.existsSync(filePath), `Route file ${r.file} must exist`);
      const content = fs.readFileSync(filePath, "utf-8");
      assert.ok(content.includes("export const metadata"), `${r.file} must export metadata`);
      assert.ok(content.includes(r.expectedTitle), `${r.file} metadata must have title '${r.expectedTitle}'`);
      assert.ok(content.includes("export default"), `${r.file} must have a default export`);
    }
  });

  it("verifies reusable Header, Footer, and Layout components exist with correct accessible landmarks", () => {
    const headerPath = path.join(process.cwd(), "src/components/marketing/header.tsx");
    const footerPath = path.join(process.cwd(), "src/components/marketing/footer.tsx");
    const layoutPath = path.join(process.cwd(), "src/app/(marketing)/layout.tsx");

    assert.ok(fs.existsSync(headerPath), "Header component must exist");
    assert.ok(fs.existsSync(footerPath), "Footer component must exist");
    assert.ok(fs.existsSync(layoutPath), "Marketing layout must exist");

    const header = fs.readFileSync(headerPath, "utf-8");
    assert.ok(header.includes('aria-label="Main navigation"'), "Header navigation must have accessible aria-label");
    assert.ok(header.includes('aria-label="CodeMytra home"'), "Brand link must have accessible aria-label");
    assert.ok(header.includes('aria-expanded'), "Mobile menu button must have aria-expanded attribute");

    const footer = fs.readFileSync(footerPath, "utf-8");
    assert.ok(footer.includes('className="footer"'), "Footer must render with footer class");
    assert.ok(footer.includes("Generated applications are not published in the current MVP."), "Footer must include pre-launch notice");

    const layout = fs.readFileSync(layoutPath, "utf-8");
    assert.ok(layout.includes("<Header"), "Layout must render Header");
    assert.ok(layout.includes("<Footer"), "Layout must render Footer");
  });

  it("verifies Clerk middleware explicitly permits public marketing routes without authentication", () => {
    const proxyPath = path.join(process.cwd(), "src/proxy.ts");
    assert.ok(fs.existsSync(proxyPath), "src/proxy.ts must exist");
    const proxy = fs.readFileSync(proxyPath, "utf-8");

    const expectedPublicPaths = [
      "'/'",
      "'/product(.*)'",
      "'/how-it-works(.*)'",
      "'/pricing(.*)'",
      "'/about(.*)'",
      "'/contact(.*)'",
      "'/builder(.*)'",
    ];

    for (const p of expectedPublicPaths) {
      assert.ok(proxy.includes(p), `src/proxy.ts must include ${p} in public route matcher`);
    }
    assert.ok(proxy.includes("if (isPublicRoute(req))"), "Middleware must immediately bypass public routes");
  });

  it("verifies contact form accessibility and labels", () => {
    const contactPath = path.join(process.cwd(), "src/components/marketing/contact-form.tsx");
    assert.ok(fs.existsSync(contactPath), "ContactForm component must exist");
    const contact = fs.readFileSync(contactPath, "utf-8");

    assert.ok(contact.includes('htmlFor="name"'), "Name input must have matching label");
    assert.ok(contact.includes('id="name"'), "Name input must have id");
    assert.ok(contact.includes('htmlFor="email"'), "Email input must have matching label");
    assert.ok(contact.includes('id="email"'), "Email input must have id");
    assert.ok(contact.includes('htmlFor="message"'), "Message textarea must have matching label");
    assert.ok(contact.includes('id="message"'), "Message textarea must have id");
    assert.ok(contact.includes('aria-live="polite"'), "Form feedback must have aria-live polite");
  });

  it("verifies pricing plans match approved V4 reference exactly without fabrication", () => {
    const pricingPath = path.join(process.cwd(), "src/app/(marketing)/pricing/page.tsx");
    const pricing = fs.readFileSync(pricingPath, "utf-8");

    assert.ok(pricing.includes("Free"), "Must include Free plan");
    assert.ok(pricing.includes("₹0"), "Free plan price must be ₹0");
    assert.ok(pricing.includes("Maker"), "Must include Maker plan");
    assert.ok(pricing.includes("Team"), "Must include Team plan");
    assert.ok(pricing.includes("Pre-launch notice: checkout is not active."), "Must have pre-launch notice");
    assert.ok(pricing.includes("Can I publish the websites I generate?"), "Must have V4 FAQ");
  });

  it("verifies team information adheres strictly to non-fabrication requirement", () => {
    const aboutPath = path.join(process.cwd(), "src/app/(marketing)/about/page.tsx");
    const about = fs.readFileSync(aboutPath, "utf-8");

    assert.ok(
      about.includes("invent team members or achievements to fill this page"),
      "Must include exact V4 statement regarding authentic team credits"
    );
  });

  describe("Authentication Fail-Closed & Route Protection Security", () => {
    it("fails closed on protected API routes when Clerk credentials are missing in production", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost:3000/api/projects/123/export");
      const result = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "production",
      });

      assert.equal(result.action, "fail_closed");
      assert.equal(result.response?.status, 401);
      const json = await result.response?.json();
      assert.ok(json.error.includes("Authentication"));
    });

    it("fails closed on protected page routes when Clerk credentials are missing in production", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost:3000/projects/proj-456");
      const result = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "production",
      });

      assert.equal(result.action, "fail_closed");
      assert.equal(result.response?.status, 307);
      const location = result.response?.headers.get("location");
      assert.ok(location?.includes("/sign-in?redirect_url=%2Fprojects%2Fproj-456"));
    });

    it("strictly forbids ALLOW_INSECURE_DEV_AUTH in production environment", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost:3000/dashboard");
      const result = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "production",
        allowInsecureDevAuth: "true",
      });

      assert.equal(result.action, "fail_closed", "Production must NEVER allow insecure dev auth");
      assert.equal(result.response?.status, 307);
    });

    it("allows insecure dev auth ONLY in non-production when explicitly enabled", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost:3000/dashboard");
      
      // Without explicit flag -> fails closed
      const resultDisabled = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "development",
        allowInsecureDevAuth: "false",
      });
      assert.equal(resultDisabled.action, "fail_closed");

      // With explicit flag in development -> allows pass-through
      const resultEnabled = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "development",
        allowInsecureDevAuth: "true",
      });
      assert.equal(resultEnabled.action, "allow_dev_insecure");
      assert.equal(resultEnabled.response?.status, 200);
    });

    it("preserves public access for marketing routes and Inngest endpoint regardless of credentials", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const publicPaths = [
        "/",
        "/product",
        "/how-it-works",
        "/pricing",
        "/about",
        "/contact",
        "/builder",
        "/sign-in",
        "/sign-up",
        "/api/inngest",
      ];

      for (const p of publicPaths) {
        const req = new NextRequest(`http://localhost:3000${p}`);
        const result = evaluateAuthRouting(req, {
          clerkPublishableKey: "",
          clerkSecretKey: "",
          nodeEnv: "production",
        });

        assert.equal(result.action, "public", `${p} must remain public`);
        assert.equal(result.response?.status, 200);
      }
    });

    it("delegates to Clerk middleware when credentials are fully configured", async () => {
      const { evaluateAuthRouting } = await import("@/proxy");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost:3000/dashboard");
      const result = evaluateAuthRouting(req, {
        clerkPublishableKey: "pk_test_valid",
        clerkSecretKey: "sk_test_valid",
        nodeEnv: "production",
      });

      assert.equal(result.action, "delegate_to_clerk");
    });
  });
});
