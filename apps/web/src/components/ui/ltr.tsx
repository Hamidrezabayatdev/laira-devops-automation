import * as React from 'react';
import { cn } from '@/lib/utils';

export type LtrProps = React.ComponentProps<'span'>;

/**
 * Bidi-isolated inline element for Latin/technical content inside Persian prose.
 * Uses unicode-bidi: isolate so identifiers, URLs, and numbers are not scrambled
 * by the bidirectional algorithm.
 */
export function Ltr({ className, ...props }: LtrProps) {
  return (
    <span
      dir="ltr"
      className={cn('ltr-embed inline-block text-left', className)}
      {...props}
    />
  );
}

/**
 * Monospace LTR element for IDs, SHA digests, run tokens, and hostnames.
 */
export function Mono({ className, ...props }: LtrProps) {
  return (
    <span
      dir="ltr"
      className={cn('ltr-embed font-mono text-[0.9em] tracking-tight text-left', className)}
      {...props}
    />
  );
}

/**
 * Chip wrapper around monospace technical values.
 */
export function MonoChip({ className, ...props }: LtrProps) {
  return (
    <span
      dir="ltr"
      className={cn(
        'ltr-embed rounded border border-[#323644] bg-[#2a2d37] px-1.5 py-0.5 font-mono text-[0.75rem] text-zinc-300',
        className,
      )}
      {...props}
    />
  );
}
