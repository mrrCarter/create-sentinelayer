/**
 * Scaffold generator — writes template files into a project directory.
 * Skips files that already exist unless force is true.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function generateScaffold({ projectDir, templateFiles, packageJsonTemplate, readmeContent, force }) {
  const written = [];
  const skipped = [];

  // Write template files (src/, tests/, .gitignore, etc.)
  for (const [relativePath, content] of Object.entries(templateFiles)) {
    const fullPath = path.join(projectDir, relativePath);
    if (!force && fs.existsSync(fullPath)) {
      skipped.push({ path: relativePath, reason: "already exists" });
      continue;
    }
    await ensureDir(path.dirname(fullPath));
    await fsp.writeFile(fullPath, content, "utf-8");
    written.push(relativePath);
  }

  // Merge or create package.json
  const pkgPath = path.join(projectDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const existing = JSON.parse(await fsp.readFile(pkgPath, "utf-8"));
    // Merge dependencies and scripts without overwriting existing keys
    if (packageJsonTemplate.dependencies) {
      existing.dependencies = { ...packageJsonTemplate.dependencies, ...(existing.dependencies || {}) };
    }
    if (packageJsonTemplate.devDependencies) {
      existing.devDependencies = { ...packageJsonTemplate.devDependencies, ...(existing.devDependencies || {}) };
    }
    if (packageJsonTemplate.scripts) {
      existing.scripts = { ...packageJsonTemplate.scripts, ...(existing.scripts || {}) };
    }
    if (!existing.type) {
      existing.type = packageJsonTemplate.type || "module";
    }
    await fsp.writeFile(pkgPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    written.push("package.json (merged)");
  } else {
    await ensureDir(path.dirname(pkgPath));
    await fsp.writeFile(pkgPath, JSON.stringify(packageJsonTemplate, null, 2) + "\n", "utf-8");
    written.push("package.json");
  }

  // Write README.md
  if (readmeContent) {
    const readmePath = path.join(projectDir, "README.md");
    if (!force && fs.existsSync(readmePath)) {
      skipped.push({ path: "README.md", reason: "already exists" });
    } else {
      await ensureDir(path.dirname(readmePath));
      await fsp.writeFile(readmePath, readmeContent, "utf-8");
      written.push("README.md");
    }
  }

  return { written, skipped };
}
