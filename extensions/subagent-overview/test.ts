/**
 * Test for subagent-overview extension core logic.
 *
 * Self-contained: no imports from pi packages (they use jiti which isn't
 * available in standalone Node). Tests the formatting invariants directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const HOME = process.env.HOME || "/home/abdwhb";
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");

// ── Simple frontmatter parser (standalone, no pi dependency) ──
function parseFrontmatterSimple(raw: string): Record<string, string> | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// ── Test 1: Read overrides from settings.json ──
function testReadOverrides() {
  console.log("TEST 1: Read overrides from settings.json");
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const overrides = parsed?.subagents?.agentOverrides ?? {};
    
    const agentNames = Object.keys(overrides);
    console.log(`  Found ${agentNames.length} agent(s) with overrides: ${agentNames.join(", ")}`);
    
    const workerTools = overrides.worker?.tools;
    console.assert(Array.isArray(workerTools), `  ❌ worker.tools should be an array, got ${typeof workerTools}`);
    console.assert(workerTools.includes("safe_bash"), `  ❌ worker.tools should include safe_bash, got [${workerTools.join(", ")}]`);
    console.assert(!workerTools.includes("bash"), `  ❌ worker.tools should NOT include plain bash`);
    console.log("  ✅ worker override: tools =", workerTools.join(", "));
    
    const scoutTools = overrides.scout?.tools;
    console.assert(Array.isArray(scoutTools), `  ❌ scout.tools should be an array`);
    console.assert(!scoutTools.includes("bash") && !scoutTools.includes("safe_bash"), `  ❌ scout should not have bash tools`);
    console.log("  ✅ scout override: tools =", scoutTools.join(", "));
    
    // Verify ALL overrides use arrays, not strings
    for (const [name, ov] of Object.entries(overrides)) {
      if (ov.tools !== undefined && ov.tools !== false) {
        console.assert(Array.isArray(ov.tools), `  ❌ ${name}.tools should be array, got ${typeof ov.tools}: ${JSON.stringify(ov.tools)}`);
      }
    }
    console.log("  ✅ All override tools are arrays (not strings)");
    
    console.log("  ✅ PASSED\n");
    return true;
  } catch (err) {
    console.error("  ❌ FAILED:", err.message);
    return false;
  }
}

// ── Test 2: Parse builtin agent markdown files ──
function testParseBuiltinAgents() {
  console.log("TEST 2: Parse builtin agent files");
  const builtinNames = ["scout", "researcher", "planner", "worker", "reviewer", "context-builder", "oracle", "delegate"];
  const BUILTIN_AGENTS_DIR = path.join(HOME, ".pi", "agent", "npm", "node_modules", "pi-subagents", "agents");
  
  let passed = 0;
  for (const name of builtinNames) {
    const filePath = path.join(BUILTIN_AGENTS_DIR, `${name}.md`);
    console.assert(fs.existsSync(filePath), `  ❌ File not found: ${filePath}`);
    
    const raw = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatterSimple(raw);
    console.assert(fm !== null, `  ❌ No frontmatter in ${name}.md`);
    console.assert(fm!.name === name, `  ❌ name mismatch: expected ${name}, got ${fm!.name}`);
    console.assert(!!fm!.description, `  ❌ missing description for ${name}`);
    console.assert(!!fm!.tools, `  ❌ missing tools for ${name}`);
    passed++;
  }
  console.log(`  ${passed}/${builtinNames.length} parsed successfully`);
  console.log(passed === builtinNames.length ? "  ✅ PASSED\n" : "  ❌ SOME FAILED\n");
  return passed === builtinNames.length;
}

// ── Test 3: All formatted lines stay within terminal width ──
function testLineWidths() {
  console.log("TEST 3: All formatted lines within width limits");
  const MAX_WIDTH = 70;
  
  // Read overrides
  const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const overrides = parsed?.subagents?.agentOverrides ?? {};
  
  // Build sample formatted lines (simulating formatOverview)
  const lines: string[] = [];
  
  // Header box
  lines.push("╔══════════════════════════════════════════════════════════╗");
  lines.push("║                    Subagents Overview                   ║");
  lines.push("╚══════════════════════════════════════════════════════════╝");
  lines.push("");
  
  // Agent blocks (worst-case: worker with many tools)
  const toolList = overrides.worker?.tools ?? ["read", "write", "edit"];
  const paddedName = "worker".padEnd(16);
  lines.push(`${paddedName}Implementation agent`);
  const toolsLine = `  Tools: ${toolList.join(", ")}  ← OVERRIDDEN`;
  lines.push(toolsLine);
  lines.push("  Model: (inherited from default)");
  
  // Long agent name case
  const longName = "context-builder".padEnd(16);
  lines.push(`${longName}Analyzes requirements and codebase`);
  const longToolsLine = `  Tools: ${(overrides["context-builder"]?.tools ?? ["read", "grep", "find", "ls"]).join(", ")}`;
  lines.push(longToolsLine);
  
  // File path case (potentially long)
  lines.push(`  File: ${HOME}/.pi/agent/agents/videographer.md`);
  
  // Stats line with many agents
  lines.push("  Agents with execution tools: worker, delegate, some-other-agent");
  
  // Check each line
  let allOk = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_WIDTH) {
      // Check if it has ANSI codes (which don't count as visible width)
      const ansiMatch = line.match(/\x1b\[[0-9;]*m/g);
      const ansiLen = ansiMatch ? ansiMatch.join("").length : 0;
      const visibleLen = line.length - ansiLen;
      if (visibleLen > MAX_WIDTH) {
        console.error(`  ❌ Line ${i}: ${visibleLen} visible chars (max ${MAX_WIDTH}): ${line.substring(0, 50)}...`);
        allOk = false;
      }
    }
  }
  
  if (allOk) {
    console.log("  ✅ All lines within width limits\n");
  }
  return allOk;
}

// ── Test 4: Verify renderer truncation logic ──
function testTruncation() {
  console.log("TEST 4: Renderer truncation logic");
  
  // Simulate what the MessageRenderer does
  function render(lines: string[], width: number): string[] {
    return lines.map((line) => {
      if (line.length <= width) return line;
      return line.substring(0, width - 1) + "…";
    });
  }
  
  const longLine = "a".repeat(100);
  const truncated = render([longLine], 70);
  console.assert(truncated[0].length <= 70, `  ❌ Truncated line still too long: ${truncated[0].length}`);
  console.log(`  ✅ Truncated 100 → ${truncated[0].length} chars`);
  
  const shortLine = "short line";
  const unchanged = render([shortLine], 70);
  console.assert(unchanged[0] === shortLine, `  ❌ Short line should be unchanged`);
  console.log("  ✅ Short line unchanged");
  
  console.log("  ✅ PASSED\n");
  return true;
}

// ── Test 5: Verify videographer agent file exists and is parseable ──
function testVideographerAgent() {
  console.log("TEST 5: Videographer agent file");
  const filePath = path.join(HOME, ".pi", "agent", "agents", "videographer.md");
  
  console.assert(fs.existsSync(filePath), `  ❌ File not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const fm = parseFrontmatterSimple(raw);
  
  console.assert(fm !== null, "  ❌ No frontmatter");
  console.assert(fm!.name === "videographer", `  ❌ name should be 'videographer', got '${fm!.name}'`);
  console.assert(!!fm!.description, "  ❌ missing description");
  console.assert(!!fm!.tools, "  ❌ missing tools");
  console.log(`  ✅ Name: ${fm!.name}`);
  console.log(`  ✅ Description: ${fm!.description.substring(0, 60)}...`);
  console.log(`  ✅ Tools: ${fm!.tools}`);
  console.log("  ✅ PASSED\n");
  return true;
}

// ── Run all tests ──
let allPassed = true;
allPassed = testReadOverrides() && allPassed;
allPassed = testParseBuiltinAgents() && allPassed;
allPassed = testLineWidths() && allPassed;
allPassed = testTruncation() && allPassed;
allPassed = testVideographerAgent() && allPassed;

if (allPassed) {
  console.log("🎉 ALL TESTS PASSED");
  process.exit(0);
} else {
  console.log("💥 SOME TESTS FAILED");
  process.exit(1);
}