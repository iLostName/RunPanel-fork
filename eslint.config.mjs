import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    // `data/` holds cloned user repos and venv symlinks — never lint it.
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "public/**",
      "next-env.d.ts",
      // Test harness and codegen are plain Node scripts, not app code.
      "tests/**",
      "scripts/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    // A long error has to open in a dialog, not fill the screen: lib/toast.ts.
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/toast.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "sonner", importNames: ["toast"], message: "Importa toast da @/lib/toast." }] },
      ],
    },
  },
];

export default config;
