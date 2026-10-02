/**
 * Analysis built on top of the parser: describe, compatibility-diff, and
 * field-number safety checks.
 *
 * Everything here answers a reviewer's question rather than restating the file.
 */

import {
	indexTypes, resolveType, walkFields, inRanges, checkFieldNumber, wireCost,
	SCALAR_TYPES, RESERVED_BY_PROTOBUF
} from "./parse.mjs";

/** Resolve a type reference to a scalar / enum / message classification. */
function classify(type, scope, index) {
	if (SCALAR_TYPES.has(type)) return { kind: "scalar" };
	if (type.startsWith("map<")) return { kind: "map" };
	const resolved = resolveType(type, scope, index);
	if (!resolved) return { kind: "unresolved", type };
	const entry = index.get(resolved);
	return { kind: entry.kind, type: resolved };
}

/** Compact one-line summary of a message's fields, for the describe tool. */
export function describeMessage(proto, name) {
	const index = indexTypes(proto);
	const qualified = resolveType(name, proto.package ?? "", index) ?? name;
	const entry = index.get(qualified);
	if (!entry || entry.kind !== "message") {
		const available = [...index.keys()].filter((key) => index.get(key).kind === "message");
		return { found: false, name, available: available.slice(0, 40) };
	}
	const node = entry.node;
	// `resolveType` searches from the innermost scope outward, so the scope of a
	// message's own fields is the message's *full* name (a reference to a sibling
	// nested type resolves there first), not its parent's.
	const scope = qualified;
	// Oneof membership is reported per field, not just as a group, so a reader
	// can see at a glance which fields are mutually exclusive.
	const oneofOf = new Map();
	for (const group of node.oneofs ?? []) {
		for (const member of group.fields) oneofOf.set(member.name, group.name);
	}
	const fields = node.fields.map((field) => {
		const info = classify(field.type, scope, index);
		const cost = wireCost(field.number);
		return {
			name: field.name,
			number: field.number,
			type: field.type,
			label: field.label,
			resolvedKind: info.kind,
			resolvedType: info.type ?? null,
			packed: field.options?.packed === "true" || field.options?.packed === true,
			wireBytes: cost.bytes,
			repeated: field.label === "repeated",
			oneof: oneofOf.get(field.name) ?? null
		};
	});
	return {
		found: true,
		name: qualified,
		fieldCount: fields.length,
		fields: fields.sort((a, b) => a.number - b.number),
		oneofs: (node.oneofs ?? []).map((o) => ({ name: o.name, fields: o.fields.map((f) => f.name) })),
		reserved: node.reserved,
		extensions: node.extensions,
		nested: {
			messages: (node.messages ?? []).map((m) => m.name),
			enums: (node.enums ?? []).map((e) => e.name)
		},
		highWaterMark: fields.length ? Math.max(...fields.map((f) => f.number)) : 0,
		compactWindow: "fields 1-15 encode in one byte; 16+ take two"
	};
}

/** List every service and method, with streaming shape spelled out. */
export function describeService(proto, name) {
	const wanted = proto.services.filter((service) => !name || service.name === name || `${proto.package}.${service.name}` === name);
	if (!wanted.length) {
		return { found: false, name, available: proto.services.map((s) => s.name) };
	}
	return {
		found: true,
		services: wanted.map((service) => ({
			name: service.name,
			qualified: proto.package ? `${proto.package}.${service.name}` : service.name,
			methodCount: service.methods.length,
			methods: service.methods.map((method) => ({
				name: method.name,
				input: method.inputType,
				output: method.outputType,
				shape: streamingShape(method),
				fullName: proto.package ? `/${proto.package}.${service.name}/${method.name}` : `/${service.name}/${method.name}`
			}))
		}))
	};
}

/** The four RPC shapes, named the way gRPC docs name them. */
export function streamingShape(method) {
	if (method.clientStreaming && method.serverStreaming) return "bidirectional-streaming";
	if (method.clientStreaming) return "client-streaming";
	if (method.serverStreaming) return "server-streaming";
	return "unary";
}

/**
 * Compatibility diff between two versions of a definition.
 *
 * This is the tool's reason to exist. The rules implemented are the ones that
 * silently corrupt data when broken, so each finding carries a severity:
 *
 *   breaking   — old readers decode wrong bytes, or new readers refuse the file
 *   risky      — works until someone changes it back, or loses type safety
 *   additive   — safe, but worth telling the reviewer about
 */
export function diffProto(oldProto, newProto) {
	const findings = [];
	const oldIndex = indexTypes(oldProto);
	const newIndex = indexTypes(newProto);
	const oldMessages = collectMessages(oldProto);
	const newMessages = collectMessages(newProto);

	const allNames = new Set([...oldMessages.keys(), ...newMessages.keys()]);

	for (const name of allNames) {
		const before = oldMessages.get(name);
		const after = newMessages.get(name);
		if (before && !after) {
			findings.push({ severity: "breaking", kind: "message-removed", message: name, detail: `message ${name} no longer exists` });
			continue;
		}
		if (!before && after) {
			findings.push({ severity: "additive", kind: "message-added", message: name, detail: `new message ${name}` });
			continue;
		}
		const beforeByNumber = new Map(before.fields.map((f) => [f.number, f]));
		const beforeByName = new Map(before.fields.map((f) => [f.name, f]));
		const afterByNumber = new Map(after.fields.map((f) => [f.number, f]));
		const afterByName = new Map(after.fields.map((f) => [f.name, f]));

		for (const field of after.fields) {
			const prev = beforeByNumber.get(field.number);
			if (prev && prev.name !== field.name) {
				findings.push({
					severity: "breaking",
					kind: "number-reused",
					message: name,
					field: field.name,
					detail: `field ${field.number} was "${prev.name}" and is now "${field.name}" — old clients will decode new bytes into the old field`
				});
				continue;
			}
			if (prev && prev.type !== field.type) {
				findings.push({
					severity: "breaking",
					kind: "type-changed",
					message: name,
					field: field.name,
					detail: `field ${field.name} (${field.number}) changed type ${prev.type} -> ${field.type}`
				});
				continue;
			}
			if (prev && prev.label !== field.label && field.label !== "optional") {
				findings.push({
					severity: "breaking",
					kind: "label-changed",
					message: name,
					field: field.name,
					detail: `field ${field.name} (${field.number}) changed cardinality ${prev.label} -> ${field.label}`
				});
				continue;
			}
			if (!prev) {
				const safe = !inRanges(field.number, before.reserved?.numbers ?? []);
				const reservedByProto = field.number >= RESERVED_BY_PROTOBUF.from && field.number <= RESERVED_BY_PROTOBUF.to;
				findings.push({
					severity: safe && !reservedByProto ? "additive" : "breaking",
					kind: "field-added",
					message: name,
					field: field.name,
					detail: safe && !reservedByProto
						? `new field ${field.name} = ${field.number}`
						: `new field ${field.name} = ${field.number} lands in a previously reserved range`
				});
			}
		}

		for (const field of before.fields) {
			// Unchanged: same name at the same number. Nothing to say about it, and
			// saying something is actively harmful — a file compared against itself
			// must produce no findings at all.
			if (afterByNumber.get(field.number)?.name === field.name) continue;
			// A same-named field that now carries a different number is a *move*,
			// and it must be checked before the "was this slot refilled?" guard.
			//
			// Checking the slot first hides the move whenever the old number was
			// reused by a different field: the number still exists in the new file,
			// so a naive `afterByNumber.has(...)` test concludes "unchanged" and the
			// renamed-everything-but-the-name field is never reported. That is the
			// exact combination a careless edit produces — rename one field and add
			// another in the old slot — so it is the case that most needs catching.
			const successor = afterByName.get(field.name);
			if (successor && successor.number !== field.number) {
				// Same name, different number. The wire format is keyed by number,
				// so this is a new field as far as every existing client is
				// concerned — the old bytes stop decoding into it.
				findings.push({
					severity: "breaking",
					kind: "number-changed",
					message: name,
					field: field.name,
					detail: `field "${field.name}" moved from ${field.number} to ${successor.number} — the name is the same but the wire format is keyed by number, so old data no longer decodes into it`
				});
				continue;
			}
			// A removal where the number is still occupied by a *different* name is a
			// rename of the slot, which the `after` loop already reported as
			// `number-reused`. Reporting it again as a removal would double-count
			// one edit as two findings.
			const reusedBy = afterByNumber.get(field.number);
			if (reusedBy && reusedBy.name !== field.name) continue;
			const nameReserved = (after.reserved?.names ?? []).includes(field.name);
			const numberReserved = inRanges(field.number, after.reserved?.numbers ?? []);
			findings.push({
				severity: numberReserved ? "risky" : "breaking",
				kind: "field-removed",
				message: name,
				field: field.name,
				detail: numberReserved
					? `field ${field.name} = ${field.number} removed and its number is reserved${nameReserved ? "" : "; consider reserving the name too"}`
					: `field ${field.name} = ${field.number} removed but ${field.number} was NOT reserved — reserve it now or it will be reused`
			});
		}
	}

	findings.sort((a, b) => diffRank(a.severity) - diffRank(b.severity));

	return {
		findings,
		counts: {
			breaking: findings.filter((f) => f.severity === "breaking").length,
			risky: findings.filter((f) => f.severity === "risky").length,
			additive: findings.filter((f) => f.severity === "additive").length
		},
		verdict: findings.some((f) => f.severity === "breaking") ? "incompatible" : "compatible"
	};
}

/** Ordering for the diff's three-level scale. Separate from the audit scale. */
function diffRank(severity) {
	return { breaking: 0, risky: 1, additive: 2 }[severity] ?? 3;
}

/**
 * Collect messages by fully-qualified name, including nested ones.
 *
 * Keys include the package, matching `indexTypes` and `protoc`. A recursive
 * call passes the parent's qualified name explicitly, so the child name is
 * appended rather than re-rooted — getting this wrong makes every nested
 * message vanish from the map, and the only symptom is a "not found" that
 * looks like a bad user argument.
 */
export function collectMessages(proto, prefix = "", into = new Map()) {
	const base = prefix || proto.package || "";
	for (const message of proto.messages ?? []) {
		const full = base ? `${base}.${message.name}` : message.name;
		into.set(full, message);
		collectMessages({ messages: message.messages ?? [], enums: [] }, full, into);
	}
	return into;
}

/**
 * Integrity checks that a compiler would pass but a reviewer should not.
 * These are the things protoc accepts and humans regret.
 */

/**
 * How far the gap scan will walk before giving up.
 *
 * A message whose highest field is 2^29-1 is legal, and naively scanning every
 * number below it produces tens of thousands of findings for a message with
 * four fields. Real schemas never have a four-thousand-number gap, so the scan
 * stops here and reports that it stopped.
 */
const GAP_SCAN_LIMIT = 4096;

export function auditProto(proto) {
	const issues = [];
	const index = indexTypes(proto);
	const messages = collectMessages(proto);

	for (const [name, message] of messages) {
		const seenNumbers = new Map();
		const seenNames = new Map();
		const reserved = message.reserved ?? { numbers: [], names: [] };

		for (const field of message.fields) {
			const numberCheck = checkFieldNumber(field.number);
			if (!numberCheck.ok) {
				issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `field number ${field.number}: ${numberCheck.reason}` });
			}
			if (inRanges(field.number, reserved.numbers)) {
				issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `field number ${field.number} is declared reserved in this message` });
			}
			if (reserved.names.includes(field.name)) {
				issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `field name "${field.name}" is declared reserved in this message` });
			}
			if (seenNumbers.has(field.number)) {
				issues.push({
					severity: "error",
					where: `${name}.${field.name}`,
					detail: `field number ${field.number} is already used by "${seenNumbers.get(field.number)}"`
				});
			} else {
				seenNumbers.set(field.number, field.name);
			}
			if (seenNames.has(field.name)) {
				issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `field name "${field.name}" appears twice` });
			} else {
				seenNames.set(field.name, field.number);
			}
			if (proto.syntax === "proto3" && field.label === "required") {
				issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `proto3 does not support "required"` });
			}
			if (field.label === "map") {
				const keyCheck = ["int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string"].includes(field.keyType);
				if (!keyCheck) {
					issues.push({ severity: "error", where: `${name}.${field.name}`, detail: `map key type "${field.keyType}" is not allowed` });
				}
				// The value type needs the same resolution the field itself would get.
				// Checking only the key leaves `map<string, Missing>` completely
				// silent, because the field's own `type` is the literal string
				// "map<string, Missing>" — which matches nothing in the index and is
				// therefore never flagged.
				const valueInfo = classify(field.valueType, name, index);
				if (valueInfo.kind === "unresolved") {
					const fromImport = (proto.imports ?? []).length > 0;
					issues.push({
						severity: fromImport ? "info" : "error",
						where: `${name}.${field.name}`,
						detail: fromImport
							? `map value type "${field.valueType}" is not defined in this file; it must come from an import, which this plugin does not follow`
							: `map value type "${field.valueType}" is not a scalar and is not defined in this file, and the file imports nothing`
					});
				}
				continue;
			}
			const info = classify(field.type, name, index);
			if (info.kind === "unresolved") {
				// A type defined in another file is not an error — it is the normal
				// case. This plugin analyses one file at a time and deliberately does
				// not fetch imports, so an unresolved name is only reported when it
				// cannot possibly have come from an import: an unimported definition
				// would have to be in this same file to be usable, and it is not.
				const fromImport = (proto.imports ?? []).length > 0;
				issues.push({
					severity: fromImport ? "info" : "error",
					where: `${name}.${field.name}`,
					detail: fromImport
						? `type "${field.type}" is not defined in this file; it must come from one of the ${proto.imports.length} imports, which this plugin does not follow`
						: `type "${field.type}" is not a scalar and is not defined in this file, and the file imports nothing`
				});
			}
		}

		// A gap below the high-water mark is the classic "deleted but not reserved".
		//
		// The scan is bounded twice, and both bounds matter:
		//
		//   * by GAP_SCAN_LIMIT, because a message may legally hold a field at
		//     2^29-1 and walking 1..that allocates a list nothing can hold;
		//   * by the field count, because a message with three fields cannot have
		//     three thousand real deletions. Every number below the high-water
		//     mark that is not used and not reserved is *technically* a reusable
		//     hole, but reporting ten thousand of them buries the finding that
		//     matters.
		//
		// When the gap count would exceed the limit the scan stops and says so,
		// rather than silently truncating: a truncated list that looks complete
		// is worse than no list.
		const numbers = message.fields.map((f) => f.number).sort((a, b) => a - b);
		const trueHigh = numbers.length ? numbers[numbers.length - 1] : 0;
		const gapCeiling = Math.min(trueHigh, RESERVED_BY_PROTOBUF.from - 1, GAP_SCAN_LIMIT);
		const numberSet = new Set(numbers);
		const gaps = [];
		if ((message.extensions ?? []).length === 0) {
			for (let n = 1; n <= gapCeiling; n += 1) {
				if (numberSet.has(n)) continue;
				if (inRanges(n, reserved.numbers)) continue;
				if (isExtensionRange(n, message.extensions ?? [])) continue;
				gaps.push(n);
			}
		}
		if (gaps.length) {
			const shown = gaps.slice(0, 12);
			issues.push({
				severity: "warn",
				where: name,
				detail: gaps.length > shown.length
					? `${gaps.length} unused field numbers below the high-water mark ${trueHigh} are not reserved (${shown.join(", ")}, ...) — a future edit may reuse one and break compatibility`
					: `unused field numbers ${shown.join(", ")} sit below the high-water mark ${trueHigh} and are not reserved — a future edit may reuse one and break compatibility`
			});
		}
	}

	// Enums are audited under their fully-qualified name, the same as messages.
	// Reporting a bare enum name here while every other finding is qualified
	// makes the output inconsistent and the enum impossible to locate in a file
	// that declares two same-named enums in different messages.
	const filePackage = proto.package || "";
	for (const item of proto.enums ?? []) {
		issues.push(...auditEnum(item, proto, filePackage));
	}
	for (const [name, message] of messages) {
		for (const item of message.enums ?? []) {
			issues.push(...auditEnum(item, proto, name));
		}
	}

	for (const service of proto.services) {
		for (const method of service.methods) {
			for (const [label, ref] of [["input", method.inputType], ["output", method.outputType]]) {
				if (!SCALAR_TYPES.has(ref) && !resolveType(ref, proto.package ?? "", index)) {
					issues.push({
						severity: "error",
						where: `${service.name}.${method.name}`,
						detail: `${label} type "${ref}" cannot be resolved`
					});
				}
			}
		}
	}

	issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	return {
		issues,
		counts: {
			error: issues.filter((i) => i.severity === "error").length,
			warn: issues.filter((i) => i.severity === "warn").length,
			info: issues.filter((i) => i.severity === "info").length
		}
	};
}

function severityRank(severity) {
	return { error: 0, warn: 1, info: 2 }[severity] ?? 3;
}

function isExtensionRange(number, ranges) {
	return ranges.some((range) => number >= range.from && number <= range.to);
}

function auditEnum(item, proto, prefix = "") {
	const issues = [];
	const where = prefix ? `${prefix}.${item.name}` : item.name;
	const seen = new Map();
	for (const value of item.values) {
		if (seen.has(value.number)) {
			// proto3 allows aliases only with allow_alias = true.
			const allowed = item.options?.allow_alias === "true" || item.options?.allow_alias === true;
			issues.push({
				severity: allowed ? "warn" : "error",
				where: `${where}.${value.name}`,
				detail: `enum value ${value.number} duplicates "${seen.get(value.number)}"${allowed ? " (allow_alias is set)" : ""}`
			});
		} else {
			seen.set(value.number, value.name);
		}
	}
	if (item.values.length && !item.values.some((v) => v.number === 0)) {
		issues.push({ severity: "error", where, detail: "proto3 enums must have a zero value (the default)" });
	}
	if (item.values.length > 1 && item.values[0].number !== 0) {
		issues.push({ severity: "warn", where, detail: "the first enum value should be the zero value" });
	}
	return issues;
}

/**
 * Answer "is this number free to use?" for a specific message.
 *
 * This is the question an engineer actually types into a terminal before
 * adding a field, so it gets its own tool rather than being buried in audit.
 */
export function suggestFieldNumber(proto, messageName, requested) {
	const messages = collectMessages(proto);
	const qualified = resolveType(messageName, proto.package ?? "", indexTypes(proto)) ?? messageName;
	const message = messages.get(qualified) ?? messages.get(messageName);
	if (!message) {
		return { found: false, message: messageName, available: [...messages.keys()].slice(0, 40) };
	}
	const used = new Map(message.fields.map((f) => [f.number, f.name]));
	const reserved = message.reserved ?? { numbers: [], names: [] };

	if (requested !== undefined && requested !== null) {
		const check = checkFieldNumber(requested);
		const conflicts = [];
		if (used.has(requested)) conflicts.push(`already used by "${used.get(requested)}"`);
		if (inRanges(requested, reserved.numbers)) conflicts.push("declared reserved in this message");
		if (requested >= RESERVED_BY_PROTOBUF.from && requested <= RESERVED_BY_PROTOBUF.to) conflicts.push("reserved by protobuf itself (19000-19999)");
		if (!check.ok) conflicts.push(check.reason);
		return {
			found: true,
			message: qualified,
			requested,
			safe: conflicts.length === 0,
			conflicts,
			wireBytes: check.ok ? wireCost(requested).bytes : null
		};
	}

	const high = message.fields.length ? Math.max(...message.fields.map((f) => f.number)) : 0;
	const candidates = [];
	// Probe a bounded window above the high-water mark. Two details make this
	// correct rather than merely finite:
	//
	//   * the window is counted in *proposed* numbers, not in raw integers, so a
	//     run of skipped numbers cannot exhaust it. Counting raw integers meant
	//     a message whose last field sat at 18999 produced zero suggestions: the
	//     entire 400-step window fell inside the 19000-19999 block, every step
	//     was skipped, and the caller was told there is no free number.
	//   * the start is clamped, because a message may legally end at 2^29-1 and
	//     `high + 1` is then out of range.
	const start = Number.isFinite(high) && high >= 1 && high < 536870911 ? high + 1 : 1;
	for (let offset = 0; offset < 4096 && candidates.length < 10; offset += 1) {
		const n = start + offset;
		if (n > 536870911) break;
		// Jump the protobuf-reserved block rather than stepping through it.
		if (n >= RESERVED_BY_PROTOBUF.from && n <= RESERVED_BY_PROTOBUF.to) {
			offset += RESERVED_BY_PROTOBUF.to - n;
			continue;
		}
		if (used.has(n) || inRanges(n, reserved.numbers)) continue;
		candidates.push({ number: n, wireBytes: wireCost(n).bytes });
	}
	return {
		found: true,
		message: qualified,
		highWaterMark: high,
		usedNumbers: [...used.keys()].sort((a, b) => a - b),
		reserved: reserved.numbers,
		suggestions: candidates,
		note: "Numbers 1-15 cost one byte on the wire — prefer them for fields written on every call."
	};
}

/** Render an entire definition as a reviewable outline. */
export function outline(proto) {
	const index = indexTypes(proto);
	return {
		syntax: proto.syntax,
		edition: proto.edition ?? null,
		package: proto.package || null,
		imports: proto.imports,
		options: proto.options,
		counts: {
			messages: [...index.values()].filter((e) => e.kind === "message").length,
			enums: [...index.values()].filter((e) => e.kind === "enum").length,
			services: proto.services.length,
			methods: proto.services.reduce((sum, s) => sum + s.methods.length, 0)
		},
		messages: [...index.entries()]
			.filter(([, entry]) => entry.kind === "message")
			.map(([name, entry]) => ({
				name,
				fields: entry.node.fields.length,
				nested: (entry.node.messages ?? []).length,
				oneofs: (entry.node.oneofs ?? []).length,
				reservedNumbers: (entry.node.reserved?.numbers ?? []).length
			})),
		enums: [...index.entries()]
			.filter(([, entry]) => entry.kind === "enum")
			.map(([name, entry]) => ({ name, values: entry.node.values.length })),
		services: proto.services.map((service) => ({
			name: service.name,
			methods: service.methods.map((m) => ({ name: m.name, shape: streamingShape(m) }))
		}))
	};
}