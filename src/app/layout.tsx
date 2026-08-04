import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/lib/theme-context";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Avantra Carrier Services",
  description: "Dispatch and back-office services for owner-operators and small fleets",
};

// Inline theme script: reads localStorage and toggles the 'dark' class on <html>
// before the first paint to avoid flash. The nonce lets it pass the strict CSP
// without needing 'unsafe-inline' in script-src.
const themeScript = `
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  } catch(e) {}
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the per-request nonce injected by the proxy (src/lib/supabase/middleware.ts)
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
