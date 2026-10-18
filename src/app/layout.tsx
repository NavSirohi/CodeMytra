import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { ClerkProvider} from '@clerk/nextjs'
const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "CodeMytra — AI Application Builder",
    template: "%s | CodeMytra",
  },
  description:
    "CodeMytra is a multi-agent AI platform that turns your ideas into complete, full-stack applications. Describe what you need and watch it get built.",
  keywords: ["AI", "app builder", "code generation", "multi-agent", "Next.js", "full-stack"],
  authors: [{ name: "CodeMytra" }],
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  openGraph: {
    title: "CodeMytra — AI Application Builder",
    description: "Turn your ideas into full-stack applications with multi-agent AI.",
    type: "website",
    url: "/",
    siteName: "CodeMytra",
  },
  twitter: {
    card: "summary_large_image",
    title: "CodeMytra — AI Application Builder",
    description: "Turn your ideas into full-stack applications with multi-agent AI.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
    >
      <body className="min-h-full flex flex-col">
      <ClerkProvider>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
          {children}
          </QueryProvider>
        </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
