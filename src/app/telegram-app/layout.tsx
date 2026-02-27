import type { Metadata } from 'next';

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
      <script src="https://telegram.org/js/telegram-web-app.js" />
      {children}
    </>
  );
}
