import type { Metadata } from "next";
import { Header } from "@/components/shell/Header";
import { manrope, inter, plexMono } from "@/lib/fonts";
import { ensureSession } from "@/lib/session-server";
import "./globals.css";

const TITLE = "Cubicle — Your first team fits in a cubicle";
const DESCRIPTION =
  "Pitch an idea and watch a four-person AI office — PM, Researcher, Designer, Developer — debate it and deliver a plan.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    siteName: "Cubicle",
    images: [{ url: "/og-cover.png", width: 1200, height: 630, alt: "Cubicle — Your first team fits in a cubicle" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og-cover.png"],
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await ensureSession();
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Header />
        {children}
      </body>
    </html>
  );
}
