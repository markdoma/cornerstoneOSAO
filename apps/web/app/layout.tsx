import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = {
  title: 'CornerstoneLabs AO — Agent orchestrator',
  description:
    'CornerstoneLabs AO — create capable AI agents. Connect your APIs. Deploy securely, anywhere.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
