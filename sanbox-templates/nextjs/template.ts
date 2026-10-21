
import { Template } from 'e2b'

export const template = Template()
  .fromBunImage('1.3')

  // Install Node.js and tools required to compile native dependencies.
  .aptInstall([
    'nodejs',
    'npm',
    'python3',
    'make',
    'g++',
    'build-essential',
    'node-gyp',
  ])

  // Debian 13 provides Node 20 by default.
  // Upgrade to Node 22 for better-sqlite3@13.0.3.
  .runCmd('sudo npm install -g n')
  .runCmd('sudo n 22')

  // Fail immediately if the required Node version is unavailable.
  .runCmd(
    'node --version && npm --version && ' +
    'node -e "if (Number(process.versions.node.split(`.`)[0]) < 22) process.exit(1)"'
  )

  // Verify native compilation tools.
  .runCmd(
    'bun --version && python3 --version && ' +
    'make --version && g++ --version && node-gyp --version'
  )

  // Initialize the canonical Next.js workspace.
  .setWorkdir('/home/user/workspace')

  .runCmd(
    'bun create next-app . --app --ts --tailwind --yes --use-bun'
  )

  // Shared frontend dependencies.
  .runCmd(
    'bun add clsx@^2.1.1 tailwind-merge@^3.6.0 lucide-react@^1.21.0 zod@^3.24.2'
  )

  // shadcn components.
  .runCmd('bunx --bun shadcn@latest init -d -y')
  .runCmd('bunx --bun shadcn@latest add -a -y')

  // Prisma dependencies: all Prisma packages use the same version.
  .runCmd(
    'bun add @prisma/client@7.10.1 @prisma/adapter-better-sqlite3@7.10.1'
  )

  .runCmd(
    'bun add -d prisma@7.10.1 @types/better-sqlite3@9.6.0'
  )

  // Install better-sqlite3 using the corrected Node environment.
  // Do not suppress native installation failures.
  .runCmd(
    'npm install --save-exact better-sqlite3@13.0.3'
  )

  // Verify that the native SQLite binding actually executes.
  .runCmd(
    `node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); const result = db.prepare('SELECT 1 AS ok').get(); if (result.ok !== 1) process.exit(1); console.log('SQLITE_NATIVE_CHECK_PASS'); db.close();"`
  )

  .setWorkdir('/home/user/workspace')
