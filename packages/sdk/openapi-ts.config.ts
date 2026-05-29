import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../../openapi.json",
  output: {
    path: "src/client",
    postProcess: ["prettier"],
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/sdk",
    "@hey-api/typescript",
  ],
});
