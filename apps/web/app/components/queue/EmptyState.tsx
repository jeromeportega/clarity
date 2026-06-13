export function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground"
      role="status"
      aria-label="No items to review"
    >
      <p className="text-sm font-medium">All caught up</p>
      <p className="mt-1 text-xs">No items need review right now.</p>
    </div>
  );
}
