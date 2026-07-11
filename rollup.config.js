import resolve from "@rollup/plugin-node-resolve";

export default {
  input: "src/index.js",
  output: [
    {
      file: "dist/index.js",
      format: "esm",
    },
    {
      file: "dist/index.cjs",
      format: "cjs",
      exports: "default",
    },
    {
      file: "dist/index.umd.js",
      format: "umd",
      name: "LineCallout3D",
    },
  ],
  external: ["maplibre-gl"],
  plugins: [resolve()],
};
