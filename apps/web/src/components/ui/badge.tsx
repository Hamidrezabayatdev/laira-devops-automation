import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors select-none',
  {
    variants: {
      variant: {
        default: 'bg-[#28c1f5]/20 text-[#28c1f5] border border-[#28c1f5]/30',
        mint: 'bg-[#87fcc4]/20 text-[#87fcc4] border border-[#87fcc4]/30',
        secondary: 'bg-[#2a2d37] text-zinc-300 border border-[#323644]',
        success: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
        warning: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
        destructive: 'bg-red-500/20 text-red-400 border border-red-500/30',
        outline: 'text-zinc-300 border border-[#323644]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
