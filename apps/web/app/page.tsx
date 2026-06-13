import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Clarity</h1>
      <p className="text-muted-foreground">
        Item-level truth for household spending. The finance module is the first
        of the home platform.
      </p>
      <Button>Get started</Button>
    </main>
  );
}
