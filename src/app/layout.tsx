import type { Metadata } from "next";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { ClerkProvider } from '@clerk/nextjs'
import { isClerkPublishableKeyValid } from "@/lib/auth-keys";
// Offline-safe font variable bindings for Next.js build
const inter = { variable: "font-sans" };
const geistSans = { variable: "font-geist-sans" };
const geistMono = { variable: "font-geist-mono" };

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
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const isKeyValid = isClerkPublishableKeyValid(clerkPublishableKey);

  if (clerkPublishableKey && !isKeyValid && process.env.NODE_ENV !== "production") {
    console.warn(
      "[CodeMytra] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is present but malformed. ClerkProvider is disabled until a valid pk_test_... or pk_live_... key is configured."
    );
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("dark", "h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
      style={{ colorScheme: "dark" }}
    >
      <body className="min-h-full flex flex-col">
        {isKeyValid ? (
          <ClerkProvider publishableKey={clerkPublishableKey}>
            <ThemeProvider
              attribute="class"
              defaultTheme="dark"
              enableSystem
              disableTransitionOnChange
            >
              <QueryProvider>{children}</QueryProvider>
            </ThemeProvider>
          </ClerkProvider>
        ) : (
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <QueryProvider>{children}</QueryProvider>
          </ThemeProvider>
        )}
      </body>
    </html>
  );
}
