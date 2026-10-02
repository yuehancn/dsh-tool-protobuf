// Shared minimal harness for the dsh-tool-protobuf tests.
//
// Two things are deliberately real and not stubbed:
//
//  1. `@deepseek-ai/dsh-tools` — so schema normalisation (`required` hoisting,
//     `additionalProperties` on every nested object, type enforcement before
//     `execute`) is exercised for real. Stubbing `defineTool` would test the
//     stub, and every mistake this series made about schema shape was a mistake
//     about the real normaliser.
//
//  2. `apply(ctx, config)` receives an already schema-resolved config, so this
//     context runs caller options through the real `Config` first. Handing a
//     partial object straight through registers zero tools, because a tool
//     whose config key is `undefined` cannot build its handler.
//
// The plugin's own modules are imported for white-box assertions; only the
// entry point is rebuilt, because the rebuild lets a test bind internals that
// the published module does not export.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// The real parser and analyser, imported from disk — these are the units under
// test for the logic suite, and they are the same objects the plugin uses.
export * as parse from "../lib/parse.mjs";
export * as analyze from "../lib/analyze.mjs";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

// Import lines become `new Function` parameters and export statements are
// dropped, because the builder below re-exports. Both patterns must span lines:
// this plugin splits its imports across lines, and a line-anchored pattern
// leaves a trailing `} from "node:fs/promises";` behind — a syntax error that
// reads like a plugin bug and is not one.
const body = source
	.replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "")
	.replace(/^import\s+"[^"]+";$/gm, "")
	.replace(/^export \{[\s\S]*?\};$/gm, "")
	.replace(/^export const /gm, "const ")
	.replace(/^export function /gm, "function ");

const INTERNALS = ["safeResolve", "loadProto", "probeExecutable", "normaliseNumber", "MAX_BYTES"];

const build = new Function(
	"z", "defineTool", "readFile", "spawn", "path", "basename", "dirname", "join", "resolve", "sep",
	"parseProto", "indexTypes", "describeMessage", "describeService", "diffProto", "auditProto", "suggestFieldNumber", "outline",
	`${body}\nreturn { Config, apply, inject, name, ${INTERNALS.join(", ")} };`
);

const parse = await import("../lib/parse.mjs");
const analyze = await import("../lib/analyze.mjs");

/** The plugin's real exports plus its internals, for white-box assertions. */
export const plugin = build(
	z, defineTool, readFile, spawn, { resolve, sep, join },
	basename, dirname, join, resolve, sep,
	parse.parseProto, parse.indexTypes, analyze.describeMessage, analyze.describeService,
	analyze.diffProto, analyze.auditProto, analyze.suggestFieldNumber, analyze.outline
);

/**
 * Build a minimal cordis-like context that records registered tools.
 *
 * `apply` is *not* called automatically — tests call it explicitly so the
 * registry can be asserted before and after.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {object} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call, capturing either its value or the thrown error.
 *
 * @param {any} definition - a tool definition exposing `execute`.
 * @param {object} args - tool arguments.
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args) {
	try {
		return { value: await definition.execute(args, { signal: undefined }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

/** Directory holding the fixture definitions. */
export const FIXTURES = resolve(new URL("./fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

/** Read and parse a fixture by name. */
export async function fixture(name) {
	const text = await readFile(join(FIXTURES, name), "utf8");
	return { text, proto: parse.parseProto(text) };
}

/**
 * Run the plugin's definitions through a real protoc, as an independent oracle.
 *
 * The whole risk with a hand-written parser is that it agrees with itself. A
 * compiler written by someone else is the only way to know the parse is right,
 * so it is used as a hard gate: a schema that protoc rejects is a parse bug in
 * this plugin, not a bad fixture.
 *
 * @param {string} file - absolute path to a .proto file.
 * @param {string} [includeDir] - directory to add to the import path.
 * @returns {Promise<{ok: boolean, code: number|null, stderr: string, stdout: string}>} the result.
 */
export function protocCheck(file, includeDir) {
	return new Promise((resolvePromise) => {
		const python = process.env.PROTOC_PYTHON;
		if (!python) {
			resolvePromise({ ok: false, code: null, stderr: "PROTOC_PYTHON not set", stdout: "" });
			return;
		}
		const args = ["-m", "grpc_tools.protoc", "-I", includeDir ?? dirname(file), "--descriptor_set_out=/dev/null"];
		if (process.platform === "win32") {
			args[args.length - 1] = `--descriptor_set_out=${join(process.env.TEMP ?? ".", "protobuf-oracle.bin")}`;
		}
		args.push(file);
		const child = spawn(python, args, { shell: false });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => resolvePromise({ ok: false, code: null, stderr: error.message, stdout }));
		child.on("close", (code) => resolvePromise({ ok: code === 0, code, stderr: stderr.trim(), stdout: stdout.trim() }));
	});
}

export default { plugin, Context, call, fixture, FIXTURES, protocCheck };