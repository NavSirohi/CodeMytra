
import { Sandbox } from "@e2b/code-interpreter";
import fs from "node:fs";
import path from "node:path";

// Load credentials locally without printing their values.
function loadEnv() {
  for (const filename of [".env.local", ".env"]) {
    const filePath = path.resolve(process.cwd(), filename);

    if (!fs.existsSync(filePath)) continue;

    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

async function main() {
  const templateId = process.env.E2B_TEMPLATE_ID;

  if (!process.env.E2B_API_KEY || !templateId) {
    throw new Error(
      "Missing E2B_API_KEY or E2B_TEMPLATE_ID. Configure them locally."
    );
  }

  console.log("Creating temporary E2B diagnostic sandbox...");

  const sandbox = await Sandbox.create({
    template: templateId,
  });

  try {
    const commands = [
      // Operating system
      "cat /etc/os-release",
      "id",

      // Runtime versions
      "node --version",
      "npm --version",
      "bun --version",

      // Native compilation tools
      "command -v node-gyp || true",
      "command -v python3 || true",
      "command -v make || true",
      "command -v g++ || true",

      // Workspace verification
      "ls -ld /home/user/workspace",
      "ls -ld /home/user/workspace/node_modules",

      // Prisma and SQLite dependencies
      "test -x /home/user/workspace/node_modules/.bin/prisma && echo PRISMA_OK || echo PRISMA_MISSING",

      "test -d /home/user/workspace/node_modules/better-sqlite3 && echo SQLITE_OK || echo SQLITE_MISSING",

      "test -d /home/user/workspace/node_modules/@prisma/client && echo PRISMA_CLIENT_OK || echo PRISMA_CLIENT_MISSING",

      "test -d /home/user/workspace/node_modules/@prisma/adapter-better-sqlite3 && echo PRISMA_ADAPTER_OK || echo PRISMA_ADAPTER_MISSING",

      // Real native SQLite functionality test
      `cd /home/user/workspace && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); const result = db.prepare('SELECT 1 AS ok').get(); if (result.ok !== 1) process.exit(1); console.log('SQLITE_RUNTIME_PASS'); db.close();"`,
    ];

    let failures = 0;

    for (const command of commands) {
      console.log(`\nCHECK: ${command}`);

      try {
        const result = await sandbox.commands.run(command, {
          timeoutMs: 15000,
        });

        console.log("Exit:", result.exitCode);
        if (result.stdout) console.log(result.stdout.trim());
        if (result.stderr) console.log(result.stderr.trim());

        if (result.exitCode !== 0) {
          failures++;
        }

        if (
          result.stdout.includes("_MISSING")
        ) {
          failures++;
        }
      } catch (error) {
        failures++;
        console.error("CHECK FAILED:", String(error));
      }
    }

    console.log("\n================================");

    if (failures === 0) {
      console.log("E2B ENVIRONMENT DIAGNOSTIC: PASS");
    } else {
      console.log(`E2B ENVIRONMENT DIAGNOSTIC: ${failures} ISSUE(S)`);
      process.exitCode = 1;
    }

    console.log("================================");
  } finally {
    await sandbox.kill();
    console.log("Temporary diagnostic sandbox terminated.");
  }
}

main().catch((error) => {
  console.error("Diagnostic failed:", String(error));
  process.exitCode = 1;
});
