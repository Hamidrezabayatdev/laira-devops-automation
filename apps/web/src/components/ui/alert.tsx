import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const alertVariants = cva(
  'relative w-full rounded-xl border p-4 text-sm [&>svg~*]:pr-7 [&>svg]:absolute [&>svg]:right-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-[#23252D] border-[#323644] text-zinc-200',
        warning: 'bg-amber-950/20 border-amber-500/30 text-amber-200 [&>svg]:text-amber-400',
        destructive: 'bg-red-950/20 border-red-500/30 text-red-200 [&>svg]:text-red-400',
        info: 'bg-sky-950/20 border-sky-500/30 text-sky-200 [&>svg]:text-sky-400',
        success: 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200 [&>svg]:text-emerald-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5
      className={cn('mb-1 font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <div
      className={cn('text-xs leading-relaxed text-zinc-400', className)}
      {...props}
    />
  );
}
