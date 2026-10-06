import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { AppShell } from "../components/AppShell";
import { InstallPrompt } from "../components/InstallPrompt";
import { OfflineBanner } from "../components/OfflineBanner";
import { PushNotifications } from "../components/PushNotifications";
import { ServiceWorkerRegister } from "../components/ServiceWorkerRegister";
import { AuthProvider } from "../lib/auth-context";
import { LanguageProvider } from "../lib/i18n";

// Runs before paint so there's no flash of the wrong theme — reads the
// user's saved choice, falling back to their OS preference.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("tuma-theme"); // "light" | "dark" | "auto" | null
    var mode = stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto";
    var theme;
    if (mode === "auto") {
      var hour = new Date().getHours();
      theme = hour >= 6 && hour < 19 ? "light" : "dark";
    } else {
      theme = mode;
    }
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

export const metadata: Metadata = {
  title: "Tuma Customer",
  description: "Tuma Concierge — customer app",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Tuma",
  },
};

export const viewport: Viewport = {
  themeColor: "#153A75",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-cream text-ink">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <ServiceWorkerRegister />
        <OfflineBanner />
        <AuthProvider>
          <LanguageProvider>
            <AppShell>{children}</AppShell>
            <PushNotifications />
          </LanguageProvider>
        </AuthProvider>
        <InstallPrompt />
      </body>
    </html>
  );
}
