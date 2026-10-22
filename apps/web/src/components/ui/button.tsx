import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        default:
          'bg-[#28c1f5] text-[#181818] font-semibold hover:bg-[#28c1f5]/90 active:scale-[0.98]',
        gradient:
          'bg-gradient-to-r from-[#87fcc4] to-[#28c1f5] text-[#181818] font-bold hover:opacity-95 shadow-sm active:scale-[0.98]',
        destructive:
          'bg-red-600 text-white hover:bg-red-700 active:scale-[0.98]',
        outline:
          'border border-[#323644] bg-transparent text-zinc-200 hover:bg-[#2a2d37] hover:text-white',
        secondary:
          'bg-[#2a2d37] text-zinc-100 hover:bg-[#323644]',
        ghost:
          'hover:bg-[#2a2d37] text-zinc-300 hover:text-white',
        link:
          'text-[#28c1f5] underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-lg px-6 text-base',
        icon: 'h-9 w-9 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
