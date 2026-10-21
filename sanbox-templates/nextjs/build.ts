
import { Template, defaultBuildLogger } from 'e2b'
import { template as nextJSTemplate } from './template'
import dotenv from 'dotenv'
dotenv.config()

/**
 * Build the CodeMytra sandbox template and publish it to E2B.
 *
 * Required environment variables (set in your local .env, never committed):
 *   E2B_API_KEY        — Your personal E2B API key (not the teacher's key)
 *   E2B_TEMPLATE_NAME  — Identifier for the published template (e.g. "codemytra-nextjs")
 *
 * Run with: npx ts-node sanbox-templates/nextjs/build.ts
 */
const apiKey = process.env.E2B_API_KEY
const templateName = process.env.E2B_TEMPLATE_NAME ?? 'codemytra-nextjs'

if (!apiKey) {
  throw new Error(
    'E2B_API_KEY is not set. Add it to your .env file. ' +
    'Create your own E2B account at https://e2b.dev — do not reuse the teacher\'s key.'
  )
}

Template.build(nextJSTemplate, templateName, {
  cpuCount: 4,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
  apiKey,
})