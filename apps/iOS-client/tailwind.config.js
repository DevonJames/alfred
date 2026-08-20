/** @type {import('tailwindcss').Config} */
const plugin = require("tailwindcss/plugin");

module.exports = {
  // NOTE: Update this to include the paths to all of your component files.
  content: ["./App.tsx", "./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  corePlugins: {
    space: false,
  },
  theme: {
    // NOTE to AI: You can extend the theme with custom colors or styles here.
    extend: {
      // Alfred: a private study at night. Warm ink, brass, candle-light.
      colors: {
        ink: {
          DEFAULT: "#0A0B0D",
          800: "#111317",
          700: "#171A1F",
          600: "#1E2229",
          500: "#272C34",
        },
        line: "#2E343D",
        bone: "#F4F1EA",
        muted: "#8D939E",
        faint: "#5F656F",
        brass: {
          DEFAULT: "#D8A54A",
          dim: "#8A6A2E",
          wash: "#2A2318",
        },
        live: "#E2574C",
        ok: "#5AA97C",
        warn: "#E0A458",
      },
      fontFamily: {
        display: ["InstrumentSerif_400Regular"],
        displayItalic: ["InstrumentSerif_400Regular_Italic"],
      },
      fontSize: {
        xs: "10px",
        sm: "12px",
        base: "14px",
        lg: "18px",
        xl: "20px",
        "2xl": "24px",
        "3xl": "32px",
        "4xl": "40px",
        "5xl": "48px",
        "6xl": "56px",
        "7xl": "64px",
        "8xl": "72px",
        "9xl": "80px",
      },
    },
  },
  darkMode: "class",
  plugins: [
    plugin(({ matchUtilities, theme }) => {
      const spacing = theme("spacing");

      // space-{n}  ->  gap: {n}
      matchUtilities(
        { space: (value) => ({ gap: value }) },
        { values: spacing, type: ["length", "number", "percentage"] }
      );

      // space-x-{n}  ->  column-gap: {n}
      matchUtilities(
        { "space-x": (value) => ({ columnGap: value }) },
        { values: spacing, type: ["length", "number", "percentage"] }
      );

      // space-y-{n}  ->  row-gap: {n}
      matchUtilities(
        { "space-y": (value) => ({ rowGap: value }) },
        { values: spacing, type: ["length", "number", "percentage"] }
      );
    }),
  ],
};

