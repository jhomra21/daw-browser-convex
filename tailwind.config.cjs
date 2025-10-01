/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["variant", [".dark &", '[data-kb-theme="dark"] &']],
  content: ["./src/**/*.{ts,tsx}"],
  // Safelist classes that are composed dynamically via cva/clsx so Tailwind generates them
  safelist: [
    // Button variants
    "bg-primary",
    "text-primary-foreground",
    "hover:bg-primary/90",
    "bg-destructive",
    "text-destructive-foreground",
    "hover:bg-destructive/90",
    "border",
    "border-input",
    "hover:bg-accent",
    "hover:text-accent-foreground",
    "bg-secondary",
    "text-secondary-foreground",
    "hover:bg-secondary/80",
    "text-primary",
    "underline-offset-4",
    "hover:underline",
    // Rings
    "ring-offset-background",
    "focus-visible:ring-2",
    "focus-visible:ring-ring",
    "focus-visible:ring-offset-2",
    // Disabled states
    "disabled:pointer-events-none",
    "disabled:opacity-50",
    // Sizes used in variants
    "h-10",
    "px-4",
    "py-2",
    "h-9",
    "px-3",
    "text-xs",
    "h-11",
    "px-8",
    "size-10",
    // Layout helpers present in base variant
    "inline-flex",
    "items-center",
    "justify-center",
    "gap-2",
    "whitespace-nowrap",
    "rounded-md",
    "text-sm",
    "font-medium",
    "transition-colors",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px"
      }
    },
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        "muted-foreground": "hsl(var(--muted-foreground) / <alpha-value>)",
        popover: "hsl(var(--popover) / <alpha-value>)",
        "popover-foreground": "hsl(var(--popover-foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        card: "hsl(var(--card) / <alpha-value>)",
        "card-foreground": "hsl(var(--card-foreground) / <alpha-value>)",
        primary: "hsl(var(--primary) / <alpha-value>)",
        "primary-foreground": "hsl(var(--primary-foreground) / <alpha-value>)",
        secondary: "hsl(var(--secondary) / <alpha-value>)",
        "secondary-foreground": "hsl(var(--secondary-foreground) / <alpha-value>)",
        accent: "hsl(var(--accent) / <alpha-value>)",
        "accent-foreground": "hsl(var(--accent-foreground) / <alpha-value>)",
        destructive: "hsl(var(--destructive) / <alpha-value>)",
        "destructive-foreground": "hsl(var(--destructive-foreground) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
        "info-foreground": "hsl(var(--info-foreground) / <alpha-value>)",
        success: "hsl(var(--success) / <alpha-value>)",
        "success-foreground": "hsl(var(--success-foreground) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        "warning-foreground": "hsl(var(--warning-foreground) / <alpha-value>)",
        error: "hsl(var(--error) / <alpha-value>)",
        "error-foreground": "hsl(var(--error-foreground) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--kb-accordion-content-height)" }
        },
        "accordion-up": {
          from: { height: "var(--kb-accordion-content-height)" },
          to: { height: 0 }
        },
        "content-show": {
          from: { opacity: 0, transform: "scale(0.96)" },
          to: { opacity: 1, transform: "scale(1)" }
        },
        "content-hide": {
          from: { opacity: 1, transform: "scale(1)" },
          to: { opacity: 0, transform: "scale(0.96)" }
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" }
        }
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "content-show": "content-show 0.2s ease-out",
        "content-hide": "content-hide 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite"
      }
    }
  }
}
