import { connection } from "next/server";
import { Suspense } from "react";
import { AccountSession } from "@/components/account-session";
import { multiuserEnabled } from "@/lib/lan-mode";
import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SpeseSmart · Le tue spese, sotto controllo",
  description: "Il tuo spazio per gestire le spese personali, con semplicità.",
};
async function SessionContent({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return <AccountSession multiuser={multiuserEnabled()}>{children}</AccountSession>;
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body><Suspense fallback={<p role="status">Caricamento…</p>}><SessionContent>{children}</SessionContent></Suspense></body>
    </html>
  );
}
