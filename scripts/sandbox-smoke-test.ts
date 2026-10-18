import fs from "fs";
import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import { runQAInspector } from "../src/server/agents/qa";
import { captureSandboxSnapshot } from "../src/server/orchestration/sandbox-snapshot";

// Load .env or .env.local if present
function loadEnv() {
  for (const envFile of [".env.local", ".env"]) {
    const envPath = path.resolve(process.cwd(), envFile);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const idx = trimmed.indexOf("=");
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

loadEnv();

async function main() {
  console.log("================================================================================");
  console.log(" CodeMytra E2B Sandbox Connectivity & Build Smoke Test");
  console.log(" Purpose: Low-level verification of E2B container lifecycle & Next.js compilation");
  console.log(" (Note: This is a smoke test using a static reference app, NOT the AI generation workflow)");
  console.log("================================================================================\n");

  const e2bKey = process.env.E2B_API_KEY;
  const e2bTemplateId = process.env.E2B_TEMPLATE_ID;

  const missingCreds: string[] = [];
  if (!e2bKey) missingCreds.push("E2B_API_KEY");
  if (!e2bTemplateId) missingCreds.push("E2B_TEMPLATE_ID");

  if (missingCreds.length > 0) {
    console.log("--------------------------------------------------------------------------------");
    console.log("STATUS: [SKIPPED] Missing E2B credentials for sandbox smoke test");
    console.log("--------------------------------------------------------------------------------");
    console.log("The following required environment variables are not set in .env or shell:\n");
    for (const c of missingCreds) {
      console.log(`  - ${c}`);
    }
    console.log("\nNote: Credentials are never committed to repository source.");
    console.log("When credentials are provided in .env, this smoke test validates:");
    console.log("  - E2B API authentication");
    console.log("  - Sandbox container provisioning");
    console.log("  - Filesystem write/read operations");
    console.log("  - TypeScript compilation inside the container");
    console.log("  - Next.js production build (`bun run build`)");
    console.log("--------------------------------------------------------------------------------\n");
    process.exit(0);
  }

  let sandbox: Sandbox | null = null;

  try {
    console.log(`▶ Step 1: Provisioning E2B sandbox container (template: ${e2bTemplateId})...`);
    sandbox = await Sandbox.create({ template: e2bTemplateId });
    console.log(`  ✓ Sandbox container provisioned: ${sandbox.sandboxId}`);

    console.log("\n▶ Step 2: Writing static Coffee Roastery application code...");
    const samplePage = `"use client";
import { useState } from "react";

interface CoffeeBean {
  id: string;
  name: string;
  origin: string;
  roast: string;
  price: string;
}

const BEANS: CoffeeBean[] = [
  { id: "1", name: "Yirgacheffe Reserve", origin: "Ethiopia", roast: "Light", price: "$18.00" },
  { id: "2", name: "Antioquia Supremo", origin: "Colombia", roast: "Medium", price: "$16.50" },
  { id: "3", name: "Sumatra Mandheling", origin: "Indonesia", roast: "Dark", price: "$17.00" },
];

export default function CoffeeApp() {
  const [selectedRoast, setSelectedRoast] = useState<string>("All");
  const filtered = selectedRoast === "All" ? BEANS : BEANS.filter(b => b.roast === selectedRoast);

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 p-8">
      <header className="max-w-4xl mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-amber-500 mb-2">Artisan Roastery</h1>
        <p className="text-stone-400">Single origin coffees roasted daily</p>
      </header>
      <section className="max-w-4xl mx-auto grid md:grid-cols-3 gap-6">
        {filtered.map((b) => (
          <div key={b.id} className="bg-stone-800 border border-stone-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-amber-400">{b.name}</h2>
            <p className="text-xs text-stone-400 mb-2">{b.origin} • {b.roast}</p>
            <p className="font-semibold">{b.price}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
`;

    await sandbox.files.write("app/page.tsx", samplePage);
    console.log("  ✓ Written app/page.tsx to sandbox filesystem.");

    console.log("\n▶ Step 3: Executing TypeScript validation and production build in sandbox...");
    const qaReport = await runQAInspector({
      files: { "app/page.tsx": samplePage },
      summary: "Smoke test: static coffee roastery baseline",
      sandboxId: sandbox.sandboxId,
      runSandboxCommands: true,
    });

    console.log(`  ✓ Quality Score: ${qaReport.score}% | Verification Mode: ${qaReport.verificationMode}`);
    if (!qaReport.passed) {
      throw new Error(`Smoke test build failed in sandbox: ${qaReport.repairInstructions}`);
    }
    console.log("  ✓ Production build and TypeScript validation SUCCEEDED in live sandbox.");

    console.log("\n▶ Step 4: Testing canonical sandbox snapshot capture...");
    const snapshot = await captureSandboxSnapshot(sandbox.sandboxId);
    console.log(`  ✓ Snapshot captured: ${snapshot.manifest.fileCount} files (${snapshot.manifest.totalSizeBytes} bytes).`);
    console.log("  ✓ All content hashes verified against SHA-256 manifests.");

    console.log("\n================================================================================");
    console.log("STATUS: [SUCCESS] Sandbox Smoke Test Passed.");
    console.log("================================================================================\n");
  } catch (error) {
    console.error("\n❌ Smoke test failed:", error);
    process.exit(1);
  } finally {
    if (sandbox) {
      try {
        console.log("Closing sandbox container...");
        await (sandbox as unknown as { kill?: () => Promise<void> }).kill?.();
      } catch {
        // Ignore kill errors
      }
    }
  }
}

main();
