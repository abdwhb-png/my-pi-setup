import { describe, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const EXTENSIONS_DIR = path.join(import.meta.dir, "..", "..", "extensions");

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      results.push(...findSourceFiles(full));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function moduleBasename(filePath: string): string {
  return path.basename(filePath, ".ts");
}

function isImportedByTest(moduleName: string, testFiles: string[]): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`from\\s+['"][^'"]*\\/${escaped}(\\.ts)?['"]`);
  for (const tf of testFiles) {
    const content = fs.readFileSync(tf, "utf-8");
    if (pattern.test(content)) return true;
  }
  return false;
}

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      results.push(...findTestFiles(full));
    } else if (e.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Modules that are pi extension entry points — not unit-testable outside pi runtime */
function isEntryPoint(content: string): boolean {
  return /export default function\s*\(/.test(content);
}

/** Modules that import pi packages (only testable through bun/jiti) */
function hasPiImport(content: string): boolean {
  return /from\s+['"]@earendil-works\//.test(content);
}

describe("Meta: every non-entry-point module is imported by a test", () => {
  const sourceFiles = findSourceFiles(EXTENSIONS_DIR);
  const testFiles = findTestFiles(EXTENSIONS_DIR);
  const entryPoints = new Set<string>();

  // Pre-compute entry point basenames so we can skip them
  for (const sf of sourceFiles) {
    const content = fs.readFileSync(sf, "utf-8");
    if (isEntryPoint(content)) {
      entryPoints.add(moduleBasename(sf));
    }
  }

  for (const mod of sourceFiles) {
    const basename = moduleBasename(mod);
    const content = fs.readFileSync(mod, "utf-8");
    const relPath = path.relative(EXTENSIONS_DIR, mod);

    // Skip pi extension entry points (only testable in integration)
    if (isEntryPoint(content) || hasPiImport(content)) continue;

    it(`${basename} (${relPath}) is imported by at least one test`, () => {
      const imported = isImportedByTest(basename, testFiles);
      if (!imported) {
        throw new Error(
          `Module "${basename}" (${relPath}) has exports but is NOT imported by any test.\n` +
          `Add an import guard in the nearest .test.ts or create a new test.`,
        );
      }
    });
  }
});
