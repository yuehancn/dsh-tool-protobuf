/**
 * dsh-tool-protobuf — read, audit and diff Protocol Buffer definitions.
 *
 * Zero external dependency: the `.proto` grammar is parsed in this package, so
 * the plugin works on a machine that has no protoc, no Python and no network.
 * Where a compiler would be needed to *verify* output, the tools instead state
 * what they read — and when a real `protoc` is on PATH, `protobuf_status`
 * reports it so the caller can cross-check independently.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { parseProto, indexTypes } from "./parse.mjs";
import {
	describeMessage, describeService, diffProto, auditProto, suggestFieldNumber, outline
} from "./analyze.mjs";

export const name = "tool-protobuf";

export const inject = ["tools"];

export const Config = z.object({
	/** Directory that relative `path` arguments resolve against. */
	workDir: z.string().default(process.cwd()),
	/** Candidate protoc executables, probed in order by protobuf_status. */
	protocCandidates: z.array(z.string()).default([
		"protoc",
		"protoc.exe",
		"C:/Program Files/protobuf/bin/protoc.exe",
		"C:/Program Files (x86)/protobuf/bin/protoc.exe"
	])
});

/**
 * Coerce a caller-supplied field number to an integer, or `undefined`.
 *
 * The schema admits a string so that "19000" is accepted, but a field number
 * has to be a number to be compared against ranges. A value that is not a
 * usable number returns undefined, which makes the tool fall back to proposing
 * numbers — better than reporting a false "safe".
 *
 * @param {unknown} value - the raw argument.
 * @returns {number|undefined} the number, or undefined when absent/invalid.
 */
export function normaliseNumber(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Resolve a caller-supplied path against the configured workDir.
 *
 * A caller names a file, never a location: only the final path segment is
 * honoured, and everything before it is discarded. That is stronger than
 * merely rejecting `..`, and it is what closes the two ways an absolute path
 * can escape:
 *
 *   * a leading `/` or `\`, which `path.resolve` would treat as a new root;
 *   * a **drive letter**, which survives a naive segment filter. `C:` is a
 *     perfectly ordinary-looking segment, so filtering out empty parts and
 *     `..` leaves `["C:", "Windows", "System32", "config", "SAM"]` — and
 *     `resolve("C:/tmp/work", "C:", "Windows", ...)` returns
 *     `C:\tmp\work\Windows\System32\config\SAM`, keeping the whole path and
 *     making the file reachable.
 *
 * A drive-letter segment (with or without a following slash) is therefore
 * dropped, as is a UNC host, before resolution.
 */
export function safeResolve(workDir, input) {
	const cleaned = String(input)
		.replace(/\\/gu, "/")
		.split("/")
		// Drop empty parts, `.` and `..`; drop drive letters like `C:` and the
		// empty part a leading `//host/share` would leave behind.
		.filter((part) => part && part !== "." && part !== ".." && !/^[A-Za-z]:$/u.test(part));
	if (cleaned.length === 0) throw new Error("path is empty after normalisation");
	// Only the final segment is kept. Everything else is a directory the caller
	// does not get to choose — including `Windows/System32/config`.
	const filename = cleaned[cleaned.length - 1];
	if (/^[A-Za-z]:$/u.test(filename)) throw new Error(`path ${JSON.stringify(input)} has no file name`);
	return path.resolve(workDir, filename);
}

/** Read a .proto file and parse it. Errors carry the next action to take. */
async function loadProto(workDir, input) {
	let full;
	try {
		full = safeResolve(workDir, input);
	} catch (error) {
		throw new Error(`cannot use path ${JSON.stringify(input)}: ${error.message}`);
	}
	let text;
	try {
		text = await readFile(full, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error(`no such file: ${full}. Pass a path relative to the configured workDir.`);
		}
		throw new Error(`cannot read ${full}: ${error.message}`);
	}
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
		throw new Error(`${full} is larger than ${MAX_BYTES} bytes; split the definition before analysing it.`);
	}
	try {
		const proto = parseProto(text);
		return { proto, full, text };
	} catch (error) {
		throw new Error(`failed to parse ${full}: ${error.message}. The parser reports the token it stopped on; check for an unbalanced brace.`);
	}
}

/** Probe an executable's version by trying the flags protoc versions accept. */
function probeExecutable(command) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, ["--version"], { shell: false });
		} catch {
			resolve(null);
			return;
		}
		let out = "";
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		child.on("error", () => done(null));
		child.stdout?.on("data", (chunk) => { out += chunk; });
		child.stderr?.on("data", (chunk) => { out += chunk; });
		child.on("close", (code) => {
			if (code !== 0) {
				done(null);
				return;
			}
			const match = /(\d+\.\d+(?:\.\d+)?)/u.exec(out);
			done({ command, version: match ? match[1] : "unknown" });
		});
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* already gone */ }
			done(null);
		}, 4000);
		timer.unref?.();
	});
}

/** Register every tool on the context. */
export function apply(ctx, config) {
	const workDir = config.workDir ?? process.cwd();
	const candidates = config.protocCandidates ?? ["protoc"];

	ctx.tools.register(defineTool({
		name: "protobuf_status",
		description:
			"Report whether a protoc compiler is available on this machine and which .proto files exist under the configured directory. Call this first when you need an independent check of a definition, because this plugin parses .proto files itself and never invokes protoc.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const lines = [];
				const compiler = value.compiler;
				lines.push(compiler.available
					? `protoc: ${compiler.command} (version ${compiler.version})`
					: `protoc: not found (tried ${compiler.tried.join(", ")})`);
				if (!compiler.available) {
					lines.push("This plugin parses definitions itself, so every other tool still works.");
				}
				lines.push(`workDir: ${value.workDir}`);
				lines.push(`parses in-process, no network, no external dependency`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: 20000,
		isConcurrencySafe: () => true,
		async execute() {
			let compiler = { available: false, tried: candidates, command: null, version: null };
			for (const command of candidates) {
				const found = await probeExecutable(command);
				if (found) {
					compiler = { available: true, tried: candidates, command: found.command, version: found.version };
					break;
				}
			}
			return {
				compiler,
				workDir,
				dependencies: [],
				note: "This plugin has no external dependency: .proto parsing, auditing and diffing all happen in-process."
			};
		},
		presentCall: () => ({ card: "generic", title: "protobuf status", kind: "other", rawInput: {} })
	}));

	ctx.tools.register(defineTool({
		name: "protobuf_outline",
		description:
			"Summarise a .proto file: syntax, package, imports, and the names and sizes of every message, enum and service. Use this to get oriented in an unfamiliar definition before reading individual messages.",
		parameters: {
			path: { type: "string", required: true }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => {
				const lines = [`${value.file}`];
				const c = value.counts;
				lines.push(`${value.syntax}${value.package ? ` · package ${value.package}` : " · no package"} · ${c.messages} messages, ${c.enums} enums, ${c.services} services, ${c.methods} methods`);
				for (const message of value.messages) {
					lines.push(`  message ${message.name} — ${message.fields} fields${message.oneofs ? `, ${message.oneofs} oneofs` : ""}`);
				}
				for (const item of value.enums) lines.push(`  enum ${item.name} — ${item.values} values`);
				for (const service of value.services) lines.push(`  service ${service.name} — ${service.methods.length} methods`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const { proto, full } = await loadProto(workDir, args.path);
			return { file: full, ...outline(proto) };
		},
		presentCall: (args) => ({ card: "generic", title: `outline ${args.path}`, kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "protobuf_describe",
		description:
			"Describe one message or service from a .proto file: every field with its number, type, cardinality and wire cost, or every RPC method with its streaming shape and full gRPC path. Types are resolved to their fully-qualified names.",
		parameters: {
			path: { type: "string", required: true },
			name: { type: "string", required: true }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => {
				if (value.message?.found) {
					const lines = [`message ${value.message.name} (${value.message.fieldCount} fields)`];
					for (const field of value.message.fields) {
						const label = field.repeated ? "repeated " : "";
						lines.push(`  ${String(field.number).padStart(4)}  ${label}${field.type}${field.resolvedType && field.resolvedType !== field.type ? ` (${field.resolvedType})` : ""} ${field.name}${field.wireBytes === 1 ? "" : `  [${field.wireBytes}-byte tag]`}`);
					}
					if (value.message.oneofs.length) {
						lines.push(`  oneofs: ${value.message.oneofs.map((o) => `${o.name}(${o.fields.join("/")})`).join(", ")}`);
					}
					return [{ type: "text", text: lines.join("\n") }];
				}
				if (value.service?.found) {
					const lines = [];
					for (const service of value.service.services) {
						lines.push(`service ${service.name} (${service.methodCount} methods)`);
						for (const method of service.methods) {
							lines.push(`  ${method.name}(${method.input}) returns (${method.output})  [${method.shape}]`);
							lines.push(`      ${method.fullName}`);
						}
					}
					return [{ type: "text", text: lines.join("\n") }];
				}
				const available = value.available ?? value.message?.available ?? [];
				return [{ type: "text", text: `nothing named "${value.requested}" in this file. Available: ${available.join(", ") || "none"}` }];
			}
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const { proto } = await loadProto(workDir, args.path);
			const message = describeMessage(proto, args.name);
			if (message.found) return { requested: args.name, message };
			const service = describeService(proto, args.name);
			if (service.found) return { requested: args.name, service };
			const index = indexTypes(proto);
			return {
				requested: args.name,
				available: [...index.keys(), ...proto.services.map((s) => s.name)],
				message,
				service
			};
		},
		presentCall: (args) => ({ card: "generic", title: `describe ${args.name}`, kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "protobuf_diff",
		description:
			"Compare two versions of a .proto definition and classify every change as breaking, risky or additive. Detects reused field numbers, retyped fields, changed cardinality, and fields removed without reserving their number — the changes that silently corrupt data on the wire.",
		parameters: {
			oldPath: { type: "string", required: true },
			newPath: { type: "string", required: true }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => {
				const lines = [`verdict: ${value.verdict} (${value.counts.breaking} breaking, ${value.counts.risky} risky, ${value.counts.additive} additive)`];
				for (const finding of value.findings) {
					lines.push(`  [${finding.severity}] ${finding.kind}: ${finding.detail}`);
				}
				if (!value.findings.length) lines.push("  no changes detected");
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const before = await loadProto(workDir, args.oldPath);
			const after = await loadProto(workDir, args.newPath);
			return { oldFile: before.full, newFile: after.full, ...diffProto(before.proto, after.proto) };
		},
		presentCall: (args) => ({ card: "generic", title: `diff ${args.oldPath} → ${args.newPath}`, kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "protobuf_audit",
		description:
			"Lint a .proto definition for problems a compiler accepts but a reviewer should not: duplicated field numbers, illegal numbers, fields colliding with reserved ranges, unresolved types, map key types, enum zero values, and gaps below the high-water mark that were never reserved.",
		parameters: {
			path: { type: "string", required: true }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => {
				const lines = [`${value.file}: ${value.counts.error} errors, ${value.counts.warn} warnings`];
				for (const issue of value.issues) {
					lines.push(`  [${issue.severity}] ${issue.where}: ${issue.detail}`);
				}
				if (!value.issues.length) lines.push("  clean");
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const { proto, full } = await loadProto(workDir, args.path);
			return { file: full, ...auditProto(proto) };
		},
		presentCall: (args) => ({ card: "generic", title: `audit ${args.path}`, kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "protobuf_next_number",
		description:
			"Report which field numbers are free in a message, or check whether a specific number is safe to use. Accounts for used numbers, declared reserved ranges, and the 19000-19999 block protobuf reserves for itself.",
		parameters: {
			path: { type: "string", required: true },
			message: { type: "string", required: true },
			// A bare `type: "integer"` is not a type the value-schema DSL accepts,
			// and `type: "any"` is refused too. `oneOf` expresses "a number", but it
			// must list **at least two** branches — a single-branch union throws
			// `oneOf must be an array of at least two schemas`, and because that
			// happens at load time it takes every other tool in the plugin down with
			// it rather than just this one.
			number: { oneOf: [{ type: "number" }, { type: "string" }] }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => {
				if (!value.found) {
					return [{ type: "text", text: `no message "${value.message}" in this file. Available: ${(value.available ?? []).join(", ")}` }];
				}
				const lines = [];
				if (value.requested !== undefined && value.requested !== null) {
					lines.push(`${value.message}: number ${value.requested} is ${value.safe ? "SAFE" : "NOT SAFE"}`);
					for (const conflict of value.conflicts) lines.push(`  - ${conflict}`);
				} else {
					lines.push(`${value.message}: high-water mark ${value.highWaterMark}`);
					lines.push(`  used: ${value.usedNumbers.join(", ") || "none"}`);
					lines.push(`  next free: ${value.suggestions.map((s) => s.number).join(", ")}`);
					lines.push(`  ${value.note}`);
				}
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const { proto } = await loadProto(workDir, args.path);
			// The schema accepts a string branch so that a caller can pass "19000"
			// as text, but a string field number is meaningless downstream. Normalise
			// here rather than in analysis, so the analysis layer only ever sees a
			// number or nothing.
			const requested = normaliseNumber(args.number);
			return suggestFieldNumber(proto, args.message, requested);
		},
		presentCall: (args) => {
			const title = args.number === undefined || args.number === null
				? `next free number in ${args.message}`
				: `check ${args.message} = ${args.number}`;
			return { card: "generic", title, kind: "other", rawInput: args };
		}
	}));
}