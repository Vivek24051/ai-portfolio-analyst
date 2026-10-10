import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Portfolio Analyst",
  description: "Conversational AI real-estate portfolio analyst",
};

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#075e54" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
