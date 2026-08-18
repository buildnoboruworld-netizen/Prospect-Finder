import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Geist_Mono, Poppins, Space_Grotesk } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Brand typography: Poppins for headings, Space Grotesk for content.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Noboru Prospector",
    template: "%s · Noboru Prospector",
  },
  description: "Internal lead-generation tool for Noboru World.",
};

// Props are written out rather than taken from Next's generated `LayoutProps<"/">`
// global: that helper only exists after `next typegen`/`next dev`/`next build`
// have written .next/types, so a bare `tsc --noEmit` on a fresh clone failed
// here with "Cannot find name 'LayoutProps'". Nothing is lost by spelling it
// out — .next/types/validator.ts still checks this module against
// `LayoutConfig<"/">` whenever those types are present, and the root route has
// no params or parallel slots. It also matches every other page and layout in
// this repo, which all declare their own props.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${poppins.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
