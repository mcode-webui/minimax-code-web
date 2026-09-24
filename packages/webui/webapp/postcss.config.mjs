import path from "node:path";
import { fileURLToPath } from "node:url";

// Tailwind's PostCSS plugin locates its config by searching upwards from
// process.cwd(). The build is invoked as `next build webapp` from
// packages/webui, so that search starts outside this project and Tailwind would
// silently fall back to an empty `content` list — which produces preflight but no
// utilities at all. Pointing at the file explicitly keeps the build correct from
// any working directory.
const dir = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(dir, "tailwind.config.mjs") },
    autoprefixer: {},
  },
};
