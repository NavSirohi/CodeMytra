import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import React from "react";
import { renderToString } from "react-dom/server";
import { Header } from "@/components/marketing/header";
import { Footer } from "@/components/marketing/footer";
import { ContactForm } from "@/components/marketing/contact-form";
import PricingPage from "@/app/(marketing)/pricing/page";
import AboutPage from "@/app/(marketing)/about/page";

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

  it("verifies reusable Header, Footer, and Layout components render accessible DOM elements", () => {
    // Functional render of Header component
    const headerHtml = renderToString(React.createElement(Header));
    assert.ok(
      headerHtml.includes('aria-label="Main navigation"'),
      "Rendered Header must have accessible aria-label navigation"
    );
    assert.ok(
      headerHtml.includes('aria-label="CodeMytra home"'),
      "Rendered Header must have accessible brand home link"
    );
    assert.ok(
      headerHtml.includes('aria-expanded="false"'),
      "Rendered Header mobile toggle must default to aria-expanded='false'"
    );
    assert.ok(
      headerHtml.includes('href="/product"'),
      "Rendered Header must contain navigation link to /product"
    );
    assert.ok(
      headerHtml.includes('href="/pricing"'),
      "Rendered Header must contain navigation link to /pricing"
    );

    // Functional render of Footer component
    const footerHtml = renderToString(React.createElement(Footer));
    assert.ok(
      footerHtml.includes('class="footer"') || footerHtml.includes('className="footer"'),
      "Rendered Footer must have footer class"
    );
    assert.ok(
      footerHtml.includes("Generated applications are not published in the current MVP."),
      "Rendered Footer must include pre-launch notice"
    );
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

  it("verifies contact form renders accessible interactive form elements and attributes", () => {
    // Functional render of ContactForm component
    const formHtml = renderToString(React.createElement(ContactForm));

    assert.ok(
      formHtml.includes('for="name"') || formHtml.includes('htmlFor="name"'),
      "Rendered form must have label htmlFor/for name"
    );
    assert.ok(
      formHtml.includes('id="name"'),
      "Rendered form must have input id='name'"
    );
    assert.ok(
      formHtml.includes('for="email"') || formHtml.includes('htmlFor="email"'),
      "Rendered form must have label htmlFor/for email"
    );
    assert.ok(
      formHtml.includes('id="email"'),
      "Rendered form must have input id='email'"
    );
    assert.ok(
      formHtml.includes('for="message"') || formHtml.includes('htmlFor="message"'),
      "Rendered form must have label htmlFor/for message"
    );
    assert.ok(
      formHtml.includes('id="message"'),
      "Rendered form must have textarea id='message'"
    );
    assert.ok(
      formHtml.includes('type="submit"'),
      "Rendered form must have submit button"
    );
  });

  it("verifies pricing plans match approved V4 reference exactly via component rendering", () => {
    // Functional render of PricingPage component
    const pricingHtml = renderToString(React.createElement(PricingPage));

    assert.ok(pricingHtml.includes("Free"), "Rendered PricingPage must include Free plan");
    assert.ok(pricingHtml.includes("₹0"), "Rendered PricingPage must display ₹0 for Free plan");
    assert.ok(pricingHtml.includes("Maker"), "Rendered PricingPage must include Maker plan");
    assert.ok(pricingHtml.includes("Team"), "Rendered PricingPage must include Team plan");
    assert.ok(
      pricingHtml.includes("Pre-launch notice: checkout is not active."),
      "Rendered PricingPage must include pre-launch notice"
    );
    assert.ok(
      pricingHtml.includes("Can I publish the websites I generate?"),
      "Rendered PricingPage must include authentic V4 FAQ section"
    );
  });

  it("verifies team information renders authentic non-fabricated statement", () => {
    // Functional render of AboutPage component
    const aboutHtml = renderToString(React.createElement(AboutPage));

    assert.ok(
      aboutHtml.includes("invent team members or achievements to fill this page"),
      "Rendered AboutPage must include authentic team disclaimer"
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
