import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN || "https://noctilucagame.com"),
  title: "Tactical Atlas — Find your next way to play",
  description: "Explore turn-based tactical games through your preferences, source-linked mechanics and visible tradeoffs. An experimental, open game-discovery project.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = (await headers()).get("x-atlas-locale") === "zh" ? "zh-CN" : "en";
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
