// One entry point for the whole suite.
//
// Three files, three levels of confidence, and the order matters:
//
//   1. logic        — the parser and the analyser, assertions on return values.
//   2. integration  — the real `defineTool` schema normaliser and the renderers.
//   3. e2e          — real files on disk, and (when a compiler is configured) a
//                     second opinion from protoc.
//
// The suites are run in child processes rather than imported, because each one
// installs its own `node:test` reporter and a shared process would interleave
// their output into something unreadable.
//
// PROTOC_PYTHON (optional): point this at a Python that has `grpc_tools`
// installed to enable the independent oracle in the e2e suite. Without it the
// oracle tests report a diagnostic and skip, which is why the summary prints
// the mode explicitly — a green run with the oracle skipped is a weaker result
// than one without it, and the difference should not be invisible.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ["test-logic.mjs", "test-integration.mjs", "test-e2e.mjs"];

const oracle = process.env.PROTOC_PYTHON;
console.log(oracle
	? `independent compiler: ${oracle}`
	: "independent compiler: not configured (set PROTOC_PYTHON to enable the oracle)");
console.log("");

function run(file) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(here, file)], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env
		});
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.on("data", (chunk) => { out += chunk; });
		child.on("close", (code) => resolvePromise({ code, out }));
	});
}

let failed = 0;
for (const suite of SUITES) {
	const { code, out } = await run(suite);
	const summary = out.match(/^# (tests|pass|fail) \d+$/gm)?.join("  ") ?? "";
	const pass = /^# fail 0$/m.test(out);
	console.log(`${pass ? "PASS" : "FAIL"}  ${suite.padEnd(24)} ${summary}`);
	if (!pass) {
		failed += 1;
		// Print the failing assertions, not the whole transcript: the point is to
		// make the failure readable without scrolling past seventy passing lines.
		console.log(out.split("\n").filter((line) => /^not ok|^\s+error:/.test(line)).join("\n"));
	}
}

console.log("");
console.log(failed === 0 ? "all suites passed" : `${failed} suite(s) failed`);
process.exit(failed === 0 ? 0 : 1);