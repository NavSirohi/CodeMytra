import "./marketing.css";
import { Header } from "@/components/marketing/header";
import { Footer } from "@/components/marketing/footer";
import { ScrollReveal } from "@/components/marketing/scroll-reveal";
import { ThemeProvider } from "@/components/providers/theme-provider";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider forcedTheme="light">
      <div className="marketing-root" style={{ colorScheme: "light" }}>
        <ScrollReveal />
        <Header />
        {children}
        <Footer />
      </div>
    </ThemeProvider>
  );
}
