import { expectTypeOf } from 'vitest';
import type { Cents } from './money';

// Smoke check that the typecheck project is wired up.
expectTypeOf<Cents>().toEqualTypeOf<number>();
