import { Template } from 'e2b'

export const template = Template()
  .fromBunImage('1.3')
  .setWorkdir('/home/user/workspace')
  .runCmd('bun create next-app . --app --ts --tailwind --yes --use-bun')
  .runCmd('bunx --bun shadcn@latest init -d -y')
  .runCmd('bunx --bun shadcn@latest add -a -y')
  .setWorkdir('/home/user/workspace')