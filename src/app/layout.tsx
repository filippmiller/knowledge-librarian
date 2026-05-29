import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Knowledge Librarian",
  description: "AI-assisted knowledge workflows for translation teams.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
