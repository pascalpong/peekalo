import base from "../../eslint.config.mjs";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  ...base,
  { ignores: [".next/**", "out/**", "next-env.d.ts"] },
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
];
