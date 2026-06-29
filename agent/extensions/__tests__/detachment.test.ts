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

/**
 * Detect the bug pattern: const f = obj.method; f()
 * In TypeScript, class methods lose `this` when detached like this.
 * Arrow-function class fields (method = () => ...) are safe.
 *
 * Pattern we look for:
 *   const b = box.someMethod;
 *   b(...)  // or b.call(...) or b.apply(...)
 */
function findDetachedMethodCalls(content: string): string[] {
  const violations: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for: const <var> = <identifier>.<methodName>;
    const detachMatch = line.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*;/
    );
    if (!detachMatch) continue;

    const [,, objName, methodName] = detachMatch;
    // We only care about methods that don't look like arrow functions
    // (arrow functions are safe: const f = obj.method = () => ...)
    if (line.includes("=") && line.includes("=>")) continue;

    // Now check if that variable is called as a method in a nearby line
    const varName = detachMatch[1];
    // Look at next 5 lines for varName(...) pattern
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (new RegExp(`\\b${varName}\\s*\\(`).test(lines[j])) {
        violations.push(
          `L${i + 1}: \`${line.trim()}\` => L${j + 1}: \`${lines[j].trim()}\` (detached method \`${objName}.${methodName}\` — may lose \`this\`)`,
        );
        break;
      }
    }
  }

  return violations;
}

describe("Meta: no class method detachment in extension sources", () => {
  const sourceFiles = findSourceFiles(EXTENSIONS_DIR);

  for (const file of sourceFiles) {
    const relPath = path.relative(EXTENSIONS_DIR, file);

    it(`no method detachment in ${relPath}`, () => {
      const content = fs.readFileSync(file, "utf-8");
      const violations = findDetachedMethodCalls(content);
      if (violations.length > 0) {
        throw new Error(
          `Method detachment violations in ${relPath}:\n` +
          violations.map((v) => `  ${v}`).join("\n") +
          "\nFix: call directly (obj.method()) or use arrow-function class fields.",
        );
      }
    });
  }
});
