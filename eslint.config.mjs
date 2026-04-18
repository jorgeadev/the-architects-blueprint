import eslintPluginAstro from "eslint-plugin-astro";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
    ...eslintPluginAstro.configs.recommended,
    {
        ignores: ["**/.astro/**", "node_modules/**", "dist/**", "web/dist/**"],
    },
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: "latest",
            sourceType: "module",
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            semi: ["error", "always"],
            quotes: ["error", "double"],
            indent: ["error", 4, { SwitchCase: 1 }],
            curly: ["error", "all"],
        },
    },
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        rules: {
            semi: ["error", "always"],
            quotes: ["error", "double"],
            indent: ["error", 4, { SwitchCase: 1 }],
            curly: ["error", "all"],
        },
    },
];
