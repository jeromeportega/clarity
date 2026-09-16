import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import './globals.css';
import { SiteNav } from './components/nav/SiteNav';
import { isClerkConfigured } from './lib/auth/session';

export const metadata: Metadata = {
  title: 'Clarity — Finance',
  description: 'Item-level truth for household spending.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const shell = (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <SiteNav />
        {children}
      </body>
    </html>
  );

  // Clerk's provider needs a publishable key; without one (tests, the public
  // demo, a fresh clone) the app renders without sign-in rather than failing.
  if (!isClerkConfigured()) return shell;
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
    >
      {shell}
    </ClerkProvider>
  );
}
