// Bundles the Node.js Lambdas (TypeScript) into single files with esbuild:
//   backend/action_dispatcher/index.ts -> .build/lambda/action_dispatcher/index.mjs
//   backend/accuracy_lab/index.ts      -> .build/lambda/accuracy_lab/index.mjs
// accuracy_lab imports web/src/device/fall.ts, so the cloud runs the SAME detector as the phones.
// Dependencies (AWS SDK v3, web-push) come from web/node_modules.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webModules = resolve(root, "web/node_modules");
const require = createRequire(resolve(root, "web/package.json"));
const { build } = require("esbuild");

for (const name of ["action_dispatcher", "accuracy_lab"]) {
  const out = resolve(root, `.build/lambda/${name}/index.mjs`);
  await build({
    entryPoints: [resolve(root, `backend/${name}/index.ts`)],
    outfile: out,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    legalComments: "none",
    nodePaths: [webModules],
    // CommonJS dependencies inside an ES module bundle still call require()
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
  });
  console.log(`bundled ${name} -> ${out}`);
}
