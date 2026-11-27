import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// The page loads first and the Markdown renderer (most of the bundle) on its own (markdown.tsx),
// so the first download stays under Vite's 500 kB warning.
test("the Markdown renderer is not in the page's own bundle", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await build({ root, logLevel: "silent", build: { write: false } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => output.output).filter(item => item.type === "chunk");
  const entry = chunks.find(chunk => chunk.isEntry);
  assert.ok(entry.code.length < 500_000, `entry is ${entry.code.length} bytes`);
  assert.ok(!entry.moduleIds.some(id => id.includes("react-markdown")));
  assert.ok(chunks.some(chunk => !chunk.isEntry && chunk.moduleIds.some(id => id.includes("react-markdown"))));
});

// Looks live in style.css and its colour variables, so both themes follow (skills/platform-engineer):
// inline styles only size or place something from data (a bar's width), and no colour literals.
test("components use no inline looks or colour literals", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const placing = new Set(["width", "height", "left", "top", "right", "bottom", "transform"]);
  const found = readdirSync(root).filter(name => name.endsWith(".tsx")).flatMap(name =>
    readFileSync(root + name, "utf8").split("\n").flatMap((line, index) => {
      const styled = [...line.matchAll(/\bstyle=\{\{([^}]*)\}\}/g)].flatMap(match =>
        [...match[1].matchAll(/([A-Za-z]+)\s*:/g)].map(key => key[1]).filter(key => !placing.has(key)));
      const bare = /\bstyle=\{(?!\{)/.test(line);
      return styled.length || bare || /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line) ? [`${name}:${index + 1}`] : [];
    }));
  assert.deepEqual(found, []);
});

// The models page's own stylesheet takes its colours from style.css's variables too: its first look
// (green panels, written as colour literals) stayed behind when the theme changed.
test("the models page's stylesheet uses the theme's colours only", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(fileURLToPath(new URL("../model-profiles.css", import.meta.url)), "utf8");
  const literals = css.split("\n").flatMap((line, index) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|light-dark\(/.test(line) ? [index + 1] : []);
  assert.deepEqual(literals, []);
});
