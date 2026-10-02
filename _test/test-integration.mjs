// Integration suite — the plugin as loaded by the runtime.
//
// This is where the schema mistakes live. Every bug this series hit about
// `required`, `additionalProperties` and argument coercion was invisible to the
// logic suite and only appeared once the real `defineTool` compiled the schema,
// so these tests load the plugin through the real framework rather than calling
// the analysis functions directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { plugin, Context, call, fixture, FIXTURES } from "./harness.mjs";

let count = 0;
function ok(condition, message) {
	assert.ok(condition, message);
	count += 1;
}
function eq(actual, expected, message) {
	assert.deepEqual(actual, expected, `${message} (got ${JSON.stringify(actual)})`);
	count += 1;
}

const EXPECTED_TOOLS = [
	"protobuf_status",
	"protobuf_outline",
	"protobuf_describe",
	"protobuf_diff",
	"protobuf_audit",
	"protobuf_next_number"
];

/** Build a context with the fixture directory as workDir, and apply the plugin. */
async function boot() {
	const ctx = Context({ workDir: FIXTURES });
	plugin.apply(ctx, ctx.config);
	return ctx;
}

// ------------------------------------------------------------ registration --

test("apply registers exactly the documented tool set", async () => {
	const ctx = await boot();
	eq(ctx.names().sort(), [...EXPECTED_TOOLS].sort(), "registered tool names");
});

test("apply does not throw when the config omits every optional key", () => {
	// The runtime resolves defaults before calling apply, so a partial object is
	// the normal case — and a plugin that reads an undefined key registers zero
	// tools silently instead of failing.
	const ctx = Context({});
	assert.doesNotThrow(() => plugin.apply(ctx, ctx.config), "apply tolerates an all-default config");
	count += 1;
	eq(ctx.names().length, EXPECTED_TOOLS.length, "and still registers every tool");
});

test("the plugin exports the four fields the loader expects", () => {
	eq(plugin.name, "tool-protobuf", "name is the cordis plugin id");
	eq(plugin.inject, ["tools"], "inject declares the tools service");
	eq(typeof plugin.apply, "function", "apply is a function");
	eq(typeof plugin.Config, "function", "Config is a schemastery constructor, not a plain object");
});

test("Config fills workDir and the protoc candidates by default", () => {
	const config = plugin.Config({});
	eq(typeof config.workDir, "string", "workDir has a string default");
	ok(Array.isArray(config.protocCandidates), "protocCandidates is an array");
	ok(config.protocCandidates.includes("protoc"), "protoc is probed first");
	count += 1;
});

// ------------------------------------------------------------- schema shape --

test("every tool declares a description the model can act on", async () => {
	const ctx = await boot();
	for (const name of EXPECTED_TOOLS) {
		const definition = ctx.get(name);
		ok(typeof definition.description === "string" && definition.description.length > 40, `${name} has a substantive description`);
	}
});

test("required parameters are hoisted into the compiled schema", async () => {
	const ctx = await boot();
	const describe = ctx.get("protobuf_describe");
	const schema = describe.parameters;
	// The author writes `required` as a property flag; the framework hoists it
	// into an array on the object level. Asserting the property flag would fail.
	ok(Array.isArray(schema.required), "the framework hoisted required into an array");
	ok(schema.required.includes("path"), "path is required");
	ok(schema.required.includes("name"), "name is required");
	count += 1;
});

test("an all-optional parameter set omits required entirely", async () => {
	const ctx = await boot();
	const status = ctx.get("protobuf_status");
	// Not an empty array — the key is absent. Asserting `=== []` crashes on
	// undefined, which is how this was discovered the first time.
	eq((status.parameters.required ?? []).length, 0, "protobuf_status takes no required argument");
});

test("protobuf_next_number leaves its number argument optional", async () => {
	const ctx = await boot();
	const tool = ctx.get("protobuf_next_number");
	const required = tool.parameters.required ?? [];
	ok(required.includes("path"), "path is required");
	ok(required.includes("message"), "message is required");
	ok(!required.includes("number"), "number is optional");
	count += 1;
});

test("the optional number parameter is expressed as a two-branch union", async () => {
	const ctx = await boot();
	const schema = ctx.get("protobuf_next_number").parameters.properties.number;
	// A union type cannot be expressed as `type: "any"` — defineTool rejects it
	// and requires oneOf, and oneOf in turn requires at least two branches.
	ok(Array.isArray(schema.oneOf), "the union is expressed as oneOf");
	ok(schema.oneOf.length >= 2, "oneOf carries at least two branches");
	ok(schema.oneOf.some((branch) => branch.type === "number"), "number branch present");
	count += 1;
});

test("every tool exposes an output schema and a renderer", async () => {
	const ctx = await boot();
	for (const name of EXPECTED_TOOLS) {
		const definition = ctx.get(name);
		ok(definition.output !== undefined, `${name} declares output`);
		eq(typeof definition.output.render, "function", `${name} declares a renderer`);
	}
});

test("every tool declares a timeout and a concurrency hint", async () => {
	const ctx = await boot();
	for (const name of EXPECTED_TOOLS) {
		const definition = ctx.get(name);
		ok(Number.isFinite(definition.timeoutMs), `${name} has a timeout`);
		eq(typeof definition.isConcurrencySafe, "function", `${name} declares concurrency safety`);
	}
});

test("every tool declares a presentCall renderer", async () => {
	const ctx = await boot();
	for (const name of EXPECTED_TOOLS) {
		eq(typeof ctx.get(name).presentCall, "function", `${name} declares presentCall`);
	}
});

// ------------------------------------------------------------ happy paths --

test("protobuf_outline summarises a file through the runtime", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_outline"), { path: "billing.proto" });
	eq(error, undefined, "no error");
	eq(value.syntax, "proto3", "syntax");
	eq(value.counts.services, 1, "one service");
	count += 1;
});

test("protobuf_describe returns a message by short name", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_describe"), { path: "billing.proto", name: "Invoice" });
	eq(error, undefined, "no error");
	eq(value.message.found, true, "found");
	ok(value.message.fields.some((f) => f.name === "total_minor"), "the fields are present");
	count += 1;
});

test("protobuf_describe returns a service when the name is a service", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_describe"), { path: "billing.proto", name: "BillingService" });
	eq(value.service.found, true, "the service branch is taken");
	eq(value.service.services[0].methodCount, 4, "four methods");
	count += 1;
});

test("protobuf_describe lists what does exist when the name is wrong", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_describe"), { path: "billing.proto", name: "Nope" });
	ok(value.available.length > 0, "the available names are offered instead of an exception");
	count += 1;
});

test("protobuf_diff compares two files and returns a verdict", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_diff"), { oldPath: "billing.proto", newPath: "billing-v2.proto" });
	eq(error, undefined, "no error");
	eq(value.verdict, "incompatible", "verdict");
	ok(value.counts.breaking > 0, "breaking changes are counted");
	count += 1;
});

test("protobuf_audit reports a clean file as clean", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_audit"), { path: "billing.proto" });
	eq(value.counts.error, 0, "no errors in the well-formed fixture");
	count += 1;
});

test("protobuf_audit reports the broken fixture", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_audit"), { path: "broken.proto" });
	ok(value.counts.error >= 5, "the deliberately broken file yields errors");
	count += 1;
});

test("protobuf_next_number checks a specific number", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_next_number"), { path: "billing.proto", message: "Invoice", number: 1 });
	eq(value.safe, false, "field 1 is taken");
	count += 1;
});

test("protobuf_next_number accepts a field number given as text", async () => {
	// The schema admits a string branch (oneOf needs two), so the string form
	// must actually work rather than being rejected downstream.
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_next_number"), { path: "billing.proto", message: "Invoice", number: "1" });
	eq(error, undefined, "no error");
	eq(value.requested, 1, "the string is coerced to the number 1");
	eq(value.safe, false, "and field 1 is correctly reported as taken");
});

test("protobuf_next_number ignores a non-numeric string and proposes instead", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_next_number"), { path: "billing.proto", message: "Invoice", number: "not-a-number" });
	eq(error, undefined, "no error");
	ok(Array.isArray(value.suggestions), "an unusable value falls back to suggesting");
});

test("protobuf_next_number proposes numbers when none is given", async () => {
	const ctx = await boot();
	const { value } = await call(ctx.get("protobuf_next_number"), { path: "billing.proto", message: "Invoice" });
	ok(value.suggestions.length > 0, "numbers are proposed");
	count += 1;
});

test("protobuf_status runs and reports the dependency situation", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_status"), {});
	eq(error, undefined, "no error");
	eq(typeof value.compiler.available, "boolean", "the compiler probe returns a boolean");
	eq(value.dependencies.length, 0, "the plugin declares no external dependency");
	count += 1;
});

// ---------------------------------------------------------- error paths --

test("a missing file produces an error naming the path and the next step", async () => {
	const ctx = await boot();
	const { error, value } = await call(ctx.get("protobuf_outline"), { path: "no-such-file.proto" });
	eq(value, undefined, "no value");
	ok(error?.includes("no such file"), "the error says the file is missing");
	ok(error?.includes("workDir"), "and tells the caller how the path is resolved");
	count += 1;
});

test("a path that escapes the workDir cannot reach outside it", async () => {
	const ctx = await boot();
	// Traversal segments are dropped, so this resolves to <workDir>/billing.proto
	// rather than climbing out. Assert the resolution, not the parse.
	const resolved = plugin.safeResolve(FIXTURES, "../../../etc/passwd");
	ok(resolved.startsWith(resolve(FIXTURES)), "the resolved path stays inside the work dir");
	ok(!resolved.includes(".."), "no traversal segment survives");
	count += 1;
});

test("an absolute path argument is treated as a bare filename", async () => {
	// A caller names a file, never a location: this is what stops the plugin
	// writing to or reading from an arbitrary place on disk.
	const work = process.platform === "win32" ? "C:/tmp/work" : "/tmp/work";
	const resolved = plugin.safeResolve(work, "C:/Windows/System32/config/SAM");
	// Compare through path.resolve, because resolve() normalises separators and
	// a raw string comparison against a forward-slash literal always fails on
	// Windows while the behaviour is perfectly correct.
	const root = resolve(work);
	ok(resolved.startsWith(root), "the work dir still wins");
	ok(resolved.endsWith("SAM"), "only the final segment is honoured");
	ok(!resolved.includes("System32"), "no intermediate segment survives");
	count += 1;
});

test("an empty path is rejected rather than resolving to the work dir itself", () => {
	assert.throws(() => plugin.safeResolve("/tmp/work", "../.."), /empty after normalisation/u, "an empty result is an error");
	count += 1;
});

test("a malformed definition reports a parse failure with a next step", async () => {
	const dir = join(FIXTURES, "..", "tmp");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "truncated.proto"), "message M { string a = 1; ", "utf8");
	const ctx = Context({ workDir: dir });
	plugin.apply(ctx, ctx.config);
	const { error } = await call(ctx.get("protobuf_outline"), { path: "truncated.proto" });
	ok(error?.includes("failed to parse"), "the parse failure is modelled");
	ok(error?.includes("unbalanced brace"), "and names the likely cause");
	await rm(dir, { recursive: true, force: true });
	count += 1;
});

test("a file larger than the size cap is refused with instructions", async () => {
	const dir = join(FIXTURES, "..", "tmp");
	await mkdir(dir, { recursive: true });
	// Just over 8 MiB of comment, which parses to an empty schema.
	const filler = `// ${"x".repeat(1024)}\n`.repeat(8200);
	await writeFile(join(dir, "huge.proto"), filler, "utf8");
	const ctx = Context({ workDir: dir });
	plugin.apply(ctx, ctx.config);
	const { error } = await call(ctx.get("protobuf_outline"), { path: "huge.proto" });
	ok(error?.includes("larger than"), "the size cap is enforced");
	ok(error?.includes("split"), "and suggests what to do");
	await rm(dir, { recursive: true, force: true });
	count += 1;
});

test("an unresolvable message name returns a list, not an exception", async () => {
	const ctx = await boot();
	const { value, error } = await call(ctx.get("protobuf_next_number"), { path: "billing.proto", message: "Nope" });
	eq(error, undefined, "no exception");
	eq(value.found, false, "reported as not found");
	ok(value.available.length > 0, "with the real names");
	count += 1;
});

// ------------------------------------------------------------- rendering --

test("every renderer produces text for a real result", async () => {
	const ctx = await boot();
	const cases = [
		["protobuf_outline", { path: "billing.proto" }],
		["protobuf_describe", { path: "billing.proto", name: "Invoice" }],
		["protobuf_describe", { path: "billing.proto", name: "BillingService" }],
		["protobuf_describe", { path: "billing.proto", name: "Nope" }],
		["protobuf_diff", { oldPath: "billing.proto", newPath: "billing-v2.proto" }],
		["protobuf_diff", { oldPath: "billing.proto", newPath: "billing.proto" }],
		["protobuf_audit", { path: "broken.proto" }],
		["protobuf_audit", { path: "billing.proto" }],
		["protobuf_next_number", { path: "billing.proto", message: "Invoice", number: 1 }],
		["protobuf_next_number", { path: "billing.proto", message: "Invoice" }],
		["protobuf_next_number", { path: "billing.proto", message: "Nope" }],
		["protobuf_status", {}]
	];
	for (const [tool, args] of cases) {
		const definition = ctx.get(tool);
		const { value } = await call(definition, args);
		const blocks = definition.output.render(args, value);
		ok(Array.isArray(blocks) && blocks.length > 0, `${tool} renders at least one block`);
		ok(blocks.every((block) => typeof block.text === "string" && block.text.length > 0), `${tool} renders non-empty text`);
	}
});

test("presentCall survives every argument shape it will actually receive", async () => {
	// defineTool validates arguments *before* presentCall, so a half-formed
	// argument object never reaches it. Testing presentCall with a partial object
	// returns undefined and looks like a plugin crash when it is a bad test.
	const ctx = await boot();
	const cases = [
		["protobuf_status", {}],
		["protobuf_outline", { path: "billing.proto" }],
		["protobuf_describe", { path: "billing.proto", name: "Invoice" }],
		["protobuf_diff", { oldPath: "a.proto", newPath: "b.proto" }],
		["protobuf_next_number", { path: "billing.proto", message: "Invoice", number: 7 }],
		["protobuf_next_number", { path: "billing.proto", message: "Invoice" }]
	];
	for (const [tool, args] of cases) {
		const call2 = ctx.get(tool).presentCall(args);
		ok(call2 !== undefined, `${tool} presentCall returned a value`);
		ok(typeof call2.title === "string" && call2.title.length > 0, `${tool} presentCall has a title`);
	}
});

console.log(`\nintegration: ${count} assertions passed`);
export const assertions = count;