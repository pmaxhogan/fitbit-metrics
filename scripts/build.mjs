/**
 * `npm run build`, the build command Cloudflare Workers Builds runs on every push.
 *
 * This is the deploy gate (stack standard ci.deploy-on-main). Workers Builds does not
 * wait for the GitHub Actions run of the same commit, so a commit that fails CI could
 * otherwise go live. Workers Builds sets WORKERS_CI=1; when it does, run the same
 * `npm run check` CI runs (typecheck, lint, format, ASCII, tests). A non-zero exit
 * fails the build, and a failed build is never deployed.
 *
 * Wrangler bundles the Worker itself during deploy, so outside Workers Builds there
 * is nothing to build and this is a no-op.
 */
import { spawnSync } from "node:child_process";

if (process.env.WORKERS_CI === "1") {
  console.log("build: Workers Builds detected, running `npm run check` before anything can deploy");
  const res = spawnSync("npm", ["run", "check"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) console.error("build: the check failed, so there is nothing to deploy");
  process.exit(res.status ?? 1);
}
console.log("build: nothing to build outside Workers Builds (wrangler bundles on deploy)");
