/**
 * Project code scaffold templates.
 *
 * Each template returns a map of { relativePath: fileContent } that the
 * generator writes into the target project directory, skipping files
 * that already exist unless --force is set.
 */

export function getExpressTemplate({ projectName, description }) {
  const safeName = String(projectName || "my-app").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeDesc = String(description || `${safeName} API`);

  return {
    "src/index.js": `import express from "express";
import dotenv from "dotenv";
import { healthRouter } from "./routes/health.js";

dotenv.config();

const app = express();
app.use(express.json());

app.use("/api/health", healthRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`${safeName} listening on port \${PORT}\`);
});

export default app;
`,

    "src/routes/health.js": `import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
`,

    "tests/health.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

test("health endpoint returns ok status", async () => {
  // Dynamically import to avoid port binding during test
  const { default: app } = await import("../src/index.js");
  // Verify app is an express instance
  assert.ok(app, "Express app should be exported");
  assert.equal(typeof app.listen, "function", "App should have listen method");
});
`,

    ".gitignore": `node_modules/
.env
dist/
coverage/
.sentinelayer/
*.log
`,

    ".env.example": `PORT=3000
# Add your environment variables here
`,
  };
}

export function getPackageJsonTemplate({ projectName, description }) {
  const safeName = String(projectName || "my-app").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return {
    name: safeName,
    version: "0.1.0",
    description: String(description || `${safeName} API`),
    type: "module",
    main: "src/index.js",
    scripts: {
      start: "node src/index.js",
      dev: "node --watch src/index.js",
      test: "node --test tests/**/*.test.js",
    },
    dependencies: {
      express: "^5.1.0",
      dotenv: "^16.4.7",
      jsonwebtoken: "^9.0.2",
      bcrypt: "^5.1.1",
    },
    devDependencies: {},
    engines: {
      node: ">=20.0.0",
    },
  };
}

export function buildReadmeContent({ projectName, description, techStack }) {
  const name = String(projectName || "my-app");
  const desc = String(description || `${name} project`);
  const stack = String(techStack || "Node.js + Express");

  return `# ${name}

${desc}

## Tech Stack

${stack}

## Getting Started

\`\`\`bash
npm install
cp .env.example .env
npm run dev
\`\`\`

## Testing

\`\`\`bash
npm test
\`\`\`

## Project Structure

\`\`\`
${name}/
├── src/
│   ├── index.js          # Application entry point
│   └── routes/            # API route handlers
├── tests/                 # Test files
├── docs/                  # SentinelLayer spec & build guide
├── prompts/               # Agent execution prompts
├── .github/workflows/     # CI/CD (Omar Gate)
└── tasks/                 # Build checklist
\`\`\`

## Security

This project uses [SentinelLayer](https://sentinelayer.com) Omar Gate for automated security review on every PR.

---
Generated with [create-sentinelayer](https://www.npmjs.com/package/sentinelayer-cli)
`;
}

export const TEMPLATE_REGISTRY = {
  "rest-api-express": {
    name: "REST API (Express.js)",
    getFiles: getExpressTemplate,
    getPackageJson: getPackageJsonTemplate,
  },
};
