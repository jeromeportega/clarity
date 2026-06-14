import type { TrueSpendBreakdown } from '../../../../../modules/finance/core/truespend/assemble';
import { CategoryRow } from './CategoryRow';

interface TrueSpendViewProps {
  breakdown: TrueSpendBreakdown;
}

export function TrueSpendView({ breakdown }: TrueSpendViewProps) {
  const { month, categories } = breakdown;

  if (categories.length === 0) {
    return (
      <div
        role="status"
        aria-label="No spend data"
        className="py-12 text-center text-muted-foreground"
      >
        No spend data for {month || 'this period'}.
      </div>
    );
  }

  return (
    <section aria-label={`True spend breakdown${month ? ` for ${month}` : ''}`}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-sm text-muted-foreground">
            <th className="py-2 px-4 font-medium">Category</th>
            <th className="py-2 px-4 text-right font-medium">Total</th>
            <th className="py-2 px-4 text-right font-medium">Items</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((cat) => (
            <CategoryRow key={cat.category} category={cat} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
