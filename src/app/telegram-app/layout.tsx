import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'Avrora Translation',
  description: 'База знаний Аврора',
};

export default function TelegramAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Required by Telegram Mini App platform — must load before app JS */}
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      {children}
    </>
  );
}
