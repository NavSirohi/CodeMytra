import { Template } from 'e2b'

export const template = Template()
  .fromBunImage('1.3')
  .setWorkdir('/home/user/workspace')
  .runCmd('bun create next-app . --app --ts --tailwind --yes --use-bun')
  .runCmd('bun add clsx@^2.1.1 tailwind-merge@^3.6.0 lucide-react@^1.21.0 zod@^3.24.2')
  .runCmd('bunx --bun shadcn@latest init -d -y')
  .runCmd('bunx --bun shadcn@latest add -a -y')
  .runCmd('bun add @prisma/client@7.8.0 @prisma/adapter-better-sqlite3@7.10.1 better-sqlite3@13.0.3')
  .runCmd('bun add -d prisma@7.10.1 @types/better-sqlite3@9.6.0')
  .setWorkdir('/home/user/workspace')