import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaLifecycle } from "@/components/pwa/pwa-lifecycle";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NIHO finance", template: "%s | NIHO finance" },
  robots: { index: false, follow: false },
  // The home-screen app (10 §1.1).
  applicationName: "NIHO finance",
  // iOS opens it in Safari: `capable: false` keeps out `mobile-web-app-capable`, which Next adds
  // whenever `appleWebApp` is an object without `capable` (and which would open the web-app window).
  appleWebApp: { capable: false, title: "NIHO finance", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Amounts are not telephone numbers.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/*
         * Not `metadata.manifest` / `app/manifest.ts`: Next adds `use-credentials` only on Vercel
         * previews, and IAP answers a request without cookies with its sign-in (10 §1.1).
         * `public/app.webmanifest` has `display: browser` + `display_override: [standalone]`:
         * Chrome opens a standalone window, iOS (which reads only `display`) opens Safari.
         */}
        <link rel="manifest" href="/app.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body className="antialiased">
        <ToastProvider>{children}</ToastProvider>
        <PwaLifecycle />
      </body>
    </html>
  );
}
