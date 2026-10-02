/**
 * dsh-tool-protobuf — read Protocol Buffer definitions without a protoc binary.
 *
 * The whole point of this plugin is that a `.proto` file is a *contract*: it
 * says what a service accepts, what a message looks like on the wire, and which
 * field numbers are reserved. Almost every real-world protobuf incident is one
 * of three things, and all three are visible from the text alone:
 *
 *   1. a field number was reused after a field was deleted, so old clients
 *      silently decode a new field's bytes into the old field's slot;
 *   2. a field was renamed but its number was not reserved, so the next author
 *      "helpfully" reuses the number;
 *   3. a `required`-looking field was added to a message that must stay
 *      backwards-compatible.
 *
 * So the tools here do not try to be a compiler. They parse the definition the
 * way a reviewer reads it, and they answer the reviewer's questions: what does
 * this message look like, what changed, is this number safe to use, does this
 * field survive a rolling upgrade.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Strip `//` line comments and `/* ... *\/` block comments, preserving newlines. */
export function stripComments(source) {
	let out = "";
	let index = 0;
	let inBlock = false;
	let quote = null;
	while (index < source.length) {
		const ch = source[index];
		const next = source[index + 1];
		// Inside a string literal nothing is a comment. Without this, a URL such
		// as "http://example.com" has its tail eaten and the file silently loses
		// an option value.
		if (quote) {
			out += ch;
			if (ch === "\\" && index + 1 < source.length) {
				out += source[index + 1];
				index += 2;
				continue;
			}
			if (ch === quote) quote = null;
			index += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			index += 1;
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				index += 2;
				out += "  ";
				continue;
			}
			out += ch === "\n" ? "\n" : " ";
			index += 1;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") {
				out += " ";
				index += 1;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			index += 2;
			out += "  ";
			continue;
		}
		out += ch;
		index += 1;
	}
	return out;
}

/**
 * Split a source into tokens, keeping string literals whole.
 *
 * Strings matter here because option values and default values are strings, and
 * a naive split on `;` would cut `option java_package = "a;b";` in half.
 */
export function tokenize(source) {
	const text = stripComments(source);
	const tokens = [];
	let index = 0;
	while (index < text.length) {
		const ch = text[index];
		if (/\s/u.test(ch)) {
			index += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let value = "";
			index += 1;
			while (index < text.length && text[index] !== quote) {
				if (text[index] === "\\" && index + 1 < text.length) {
					value += text[index] + text[index + 1];
					index += 2;
					continue;
				}
				value += text[index];
				index += 1;
			}
			index += 1; // closing quote
			tokens.push({ kind: "string", value });
			continue;
		}
		const two = text.slice(index, index + 2);
		if (["=>", ">=", "<=", "==", "!="].includes(two)) {
			tokens.push({ kind: "punct", value: two });
			index += 2;
			continue;
		}
		if ("{}[]()<>=;,.:".includes(ch)) {
			tokens.push({ kind: "punct", value: ch });
			index += 1;
			continue;
		}
		const word = new RegExp(`^(?:${IDENT}|[0-9][0-9A-Za-z_.+-]*)`, "u").exec(text.slice(index));
		if (word) {
			tokens.push({ kind: "word", value: word[0] });
			index += word[0].length;
			continue;
		}
		index += 1; // unknown byte, skip rather than fail the whole parse
	}
	return tokens;
}

/** Scalar field types, in the order the spec lists them. */
export const SCALAR_TYPES = new Set([
	"double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
	"fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes"
]);

/** Wire types keyed by the type a user writes. Needed for field-number ranges. */
export const WIRE_TYPE = {
	double: 1, float: 5, int32: 0, int64: 0, uint32: 0, uint64: 0,
	sint32: 0, sint64: 0, fixed32: 5, fixed64: 1, sfixed32: 5, sfixed64: 1,
	bool: 0, string: 2, bytes: 2
};

/** 19000-19999 is reserved by protobuf itself and can never be used. */
export const RESERVED_BY_PROTOBUF = { from: 19000, to: 19999 };

/**
 * The `field` grammar is only valid inside a message (or a group).
 * This is the single biggest source of "why did my parse produce nothing":
 * people run it against a bare service block and expect fields.
 */
export function parseProto(source) {
	const tokens = tokenize(source);
	let position = 0;
	const peek = (offset = 0) => tokens[position + offset];
	const next = () => tokens[position++];
	const eat = (value) => {
		const token = peek();
		if (token && token.value === value) {
			position += 1;
			return true;
		}
		return false;
	};
	const expect = (value) => {
		if (!eat(value)) {
			const got = peek();
			throw new Error(`expected ${JSON.stringify(value)} but found ${got ? JSON.stringify(got.value) : "end of input"}`);
		}
	};

	/** Read a dotted type name: `foo.bar.Baz` or `.foo.Bar`. */
	function readQualifiedName() {
		let name = "";
		if (peek()?.value === ".") {
			name += ".";
			position += 1;
		}
		name += next().value;
		while (peek()?.value === ".") {
			position += 1;
			name += `.${next().value}`;
		}
		return name;
	}

	/** Skip a balanced `{...}` or `[...]` group without interpreting it. */
	function skipBlock(open, close) {
		if (!eat(open)) return;
		let depth = 1;
		while (position < tokens.length && depth > 0) {
			const token = next();
			if (token.value === open) depth += 1;
			else if (token.value === close) depth -= 1;
		}
	}

	/**
	 * Read `[...]` field options into an object. Only the options a reviewer
	 * cares about are kept; the rest are recorded by name so nothing is lost.
	 */
	function readFieldOptions() {
		const options = {};
		if (!eat("[")) return options;
		while (position < tokens.length && peek()?.value !== "]") {
			let key = next().value;
			if (peek()?.value === "." && tokens[position + 1]) {
				// option names can be qualified like (my.custom).field
				position += 1;
				key += `.${next().value}`;
			}
			if (eat("=")) {
				const valueToken = next();
				if (valueToken.value === "{") {
					// aggregate option, consume to the matching brace
					position -= 1;
					skipBlock("{", "}");
					options[key] = "<aggregate>";
				} else {
					options[key] = valueToken.kind === "string" ? valueToken.value : valueToken.value;
				}
			} else {
				options[key] = true;
			}
			if (!eat(",")) break;
		}
		eat("]");
		return options;
	}

	/** `reserved 2, 15, 9 to 11;` or `reserved "foo", "bar";` */
	function readReserved() {
		const numbers = [];
		const names = [];
		while (position < tokens.length && peek()?.value !== ";") {
			const token = next();
			if (token.kind === "string") {
				names.push(token.value);
				eat(",");
				continue;
			}
			if (token.value === ",") continue;
			const start = Number(token.value);
			if (!Number.isFinite(start)) continue;
			if (peek()?.value === "to") {
				position += 1;
				const endToken = next().value;
				const end = endToken === "max" ? Number.MAX_SAFE_INTEGER : Number(endToken);
				numbers.push({ from: start, to: end });
			} else {
				numbers.push({ from: start, to: start });
			}
			eat(",");
		}
		eat(";");
		return { numbers, names };
	}

	const proto = {
		syntax: "proto2",
		package: "",
		imports: [],
		options: {},
		messages: [],
		enums: [],
		services: []
	};

	/** Parse the body of a message or group. */
	function parseMessageBody(scope) {
		while (position < tokens.length) {
			const token = peek();
			if (!token) break;
			if (token.value === "}") return;
			if (token.value === ";") {
				position += 1;
				continue;
			}
			if (token.value === "message" || token.value === "group") {
				position += 1;
				scope.messages.push(parseMessage(next().value));
				continue;
			}
			if (token.value === "enum") {
				position += 1;
				scope.enums.push(parseEnum(next().value));
				continue;
			}
			if (token.value === "oneof") {
				position += 1;
				const oneofName = next().value;
				expect("{");
				const members = [];
				while (position < tokens.length && peek()?.value !== "}") {
					if (eat(";")) continue;
					if (peek()?.value === "option") {
						// oneof-level options are legal and not fields.
						position += 1;
						readQualifiedName();
						eat("=");
						next();
						eat(";");
						continue;
					}
					const field = parseField("oneof");
					if (!field) {
						position += 1;
						continue;
					}
					field.oneof = oneofName;
					members.push(field);
				}
				expect("}");
				scope.oneofs.push({ name: oneofName, fields: members });
				// A oneof member is a real field of the message: it has a number,
				// occupies the wire format, and counts toward the high-water mark.
				// Keeping it only inside `oneofs` makes every downstream tool blind
				// to it — the field simply does not exist as far as describe, audit
				// and diff are concerned, and nothing reports an error.
				scope.fields.push(...members);
				continue;
			}
			if (token.value === "reserved") {
				position += 1;
				const reserved = readReserved();
				scope.reserved.numbers.push(...reserved.numbers);
				scope.reserved.names.push(...reserved.names);
				continue;
			}
			if (token.value === "option") {
				position += 1;
				const name = readQualifiedName();
				eat("=");
				const value = next();
				scope.options[name] = value.kind === "string" ? value.value : value.value;
				eat(";");
				continue;
			}
			if (token.value === "extensions") {
				position += 1;
				const ranges = [];
				while (position < tokens.length && peek()?.value !== ";") {
					const t = next();
					if (t.value === ",") continue;
					const start = Number(t.value);
					if (!Number.isFinite(start)) continue;
					if (peek()?.value === "to") {
						position += 1;
						const endToken = next().value;
						ranges.push({ from: start, to: endToken === "max" ? Number.MAX_SAFE_INTEGER : Number(endToken) });
					} else {
						ranges.push({ from: start, to: start });
					}
				}
				eat(";");
				scope.extensions.push(...ranges);
				continue;
			}
			// anything else at this level should be a field
			const field = parseField("message");
			if (!field) {
				position += 1;
				continue;
			}
			scope.fields.push(field);
		}
	}

	/** Parse a single field line. Returns null when the line is not a field. */
	function parseField(context) {
		const labels = ["optional", "required", "repeated"];
		let label = "optional";
		let explicitLabel = false;
		if (labels.includes(peek()?.value)) {
			label = next().value;
			explicitLabel = true;
		}
		let typeToken = peek();
		if (!typeToken) return null;
		// `map<key, value>`
		if (typeToken.value === "map") {
			position += 1;
			expect("<");
			const keyType = next().value;
			eat(",");
			const valueType = readQualifiedName();
			expect(">");
			const name = next().value;
			expect("=");
			const number = Number(next().value);
			const options = readFieldOptions();
			eat(";");
			return { name, number, type: `map<${keyType}, ${valueType}>`, label: "map", keyType, valueType, options, explicitLabel: false, context };
		}
		const type = readQualifiedName();
		const name = next()?.value;
		if (name === undefined || peek()?.value !== "=") {
			// not a field after all — rewind is not possible, so report nothing
			return null;
		}
		expect("=");
		const number = Number(next().value);
		const options = readFieldOptions();
		let oneof = null;
		if (context === "oneof") oneof = "<current>";
		eat(";");
		return { name, number, type, label, options, explicitLabel, context, oneof };
	}

	/** `enum Foo { A = 0; B = 1; }` */
	function parseEnum(name) {
		const item = { name, values: [], reserved: { numbers: [], names: [] }, options: {} };
		expect("{");
		while (position < tokens.length && peek()?.value !== "}") {
			if (eat(";")) continue;
			if (eat("option")) {
				const key = readQualifiedName();
				eat("=");
				item.options[key] = next().value;
				eat(";");
				continue;
			}
			if (eat("reserved")) {
				const reserved = readReserved();
				item.reserved.numbers.push(...reserved.numbers);
				item.reserved.names.push(...reserved.names);
				continue;
			}
			const valueName = next()?.value;
			if (valueName === undefined) break;
			if (!eat("=")) continue;
			const value = Number(next().value);
			const options = readFieldOptions();
			eat(";");
			item.values.push({ name: valueName, number: value, options });
		}
		expect("}");
		return item;
	}

	/** A message-level container matching the shape fields/oneofs/reserved. */
	function parseMessage(name) {
		const message = {
			name,
			fields: [],
			messages: [],
			enums: [],
			oneofs: [],
			reserved: { numbers: [], names: [] },
			extensions: [],
			options: {}
		};
		expect("{");
		parseMessageBody(message);
		expect("}");
		return message;
	}

	/** `service Foo { rpc Bar (Req) returns (Res); }` */
	function parseService(name) {
		const service = { name, methods: [], options: {} };
		expect("{");
		while (position < tokens.length && peek()?.value !== "}") {
			if (eat(";")) continue;
			if (eat("option")) {
				const key = readQualifiedName();
				eat("=");
				service.options[key] = next().value;
				eat(";");
				continue;
			}
			if (!eat("rpc")) {
				position += 1;
				continue;
			}
			const method = { name: next().value, inputType: "", outputType: "", clientStreaming: false, serverStreaming: false, options: {} };
			expect("(");
			if (eat("stream")) method.clientStreaming = true;
			method.inputType = readQualifiedName();
			expect(")");
			expect("returns");
			expect("(");
			if (eat("stream")) method.serverStreaming = true;
			method.outputType = readQualifiedName();
			expect(")");
			if (eat("{")) {
				while (position < tokens.length && peek()?.value !== "}") {
					if (eat(";")) continue;
					if (eat("option")) {
						const key = readQualifiedName();
						eat("=");
						method.options[key] = next().value;
						eat(";");
						continue;
					}
					position += 1;
				}
				expect("}");
			} else {
				eat(";");
			}
			method.streaming = method.clientStreaming || method.serverStreaming;
			service.methods.push(method);
		}
		expect("}");
		return service;
	}

	while (position < tokens.length) {
		const token = peek();
		if (!token) break;
		if (token.value === ";") {
			position += 1;
			continue;
		}
		if (token.value === "syntax") {
			position += 1;
			eat("=");
			proto.syntax = next().value;
			eat(";");
			continue;
		}
		if (token.value === "edition") {
			position += 1;
			eat("=");
			proto.edition = next().value;
			eat(";");
			continue;
		}
		if (token.value === "package") {
			position += 1;
			proto.package = readQualifiedName();
			eat(";");
			continue;
		}
		if (token.value === "import") {
			position += 1;
			const modifier = peek()?.value === "public" || peek()?.value === "weak" ? next().value : "default";
			proto.imports.push({ path: next().value, modifier });
			eat(";");
			continue;
		}
		if (token.value === "option") {
			position += 1;
			const name = readQualifiedName();
			eat("=");
			proto.options[name] = next().value;
			eat(";");
			continue;
		}
		if (token.value === "message") {
			position += 1;
			proto.messages.push(parseMessage(next().value));
			continue;
		}
		if (token.value === "enum") {
			position += 1;
			proto.enums.push(parseEnum(next().value));
			continue;
		}
		if (token.value === "service") {
			position += 1;
			proto.services.push(parseService(next().value));
			continue;
		}
		if (token.value === "extend") {
			// `extend Foo { ... }` adds fields to a message defined elsewhere. This
			// plugin does not model extensions, but the block must be consumed as a
			// unit: if it falls through to the field parser, `extend Foo` is read as
			// a field of type `extend` and the block's braces are swallowed, taking
			// every subsequent top-level declaration with them. That failure is
			// silent — the file parses, and half the messages are simply absent.
			position += 1;
			readQualifiedName();
			if (peek()?.value === "{") {
				skipBlock("{", "}");
			} else {
				eat(";");
			}
			continue;
		}
		// Unknown top-level construct (extend, custom option, ...). Skip one
		// balanced statement so a single unparsed feature cannot poison the file.
		skipStatement();
	}

	/** Skip to the end of the current statement, honouring nesting. */
	function skipStatement() {
		let depth = 0;
		while (position < tokens.length) {
			const token = next();
			if (token.value === "{" || token.value === "[" || token.value === "(") depth += 1;
			else if (token.value === "}" || token.value === "]" || token.value === ")") {
				if (depth === 0) {
					position -= 1;
					return;
				}
				depth -= 1;
			} else if (token.value === ";" && depth === 0) {
				return;
			}
		}
	}

	return proto;
}

/**
 * Flatten nested messages/enums into a name-keyed index.
 *
 * Keys are *fully qualified* — the package is part of the name, because that is
 * how protobuf resolves a reference and how `protoc` reports it. Omitting the
 * package here would make every lookup inside a packaged file fail, which is
 * most real files, and the failure is invisible: a lookup returns null and the
 * caller reports the type as simply absent.
 *
 * The recursion is driven by an explicit prefix rather than by re-entering with
 * the parent object, because a nested message's own `name` must be appended to
 * the parent's *qualified* name, not treated as a fresh root.
 */
export function indexTypes(proto, prefix = "", into = new Map()) {
	// A call with no prefix and no explicit scope starts from the file's package;
	// a recursive call passes the parent's qualified name and must not re-apply it.
	const base = prefix || proto.package || "";
	for (const message of proto.messages ?? []) {
		const full = base ? `${base}.${message.name}` : message.name;
		into.set(full, { kind: "message", full, node: message });
		indexNested(message, full, into);
	}
	for (const item of proto.enums ?? []) {
		const full = base ? `${base}.${item.name}` : item.name;
		into.set(full, { kind: "enum", full, node: item });
	}
	return into;
}

/** Index the children of one message, whose qualified name is `full`. */
function indexNested(message, full, into) {
	for (const nested of message.messages ?? []) {
		const childFull = `${full}.${nested.name}`;
		into.set(childFull, { kind: "message", full: childFull, node: nested });
		indexNested(nested, childFull, into);
	}
	for (const item of message.enums ?? []) {
		const childFull = `${full}.${item.name}`;
		into.set(childFull, { kind: "enum", full: childFull, node: item });
	}
}

/**
 * Resolve a type reference to a fully-qualified name.
 *
 * This is where protobuf's scoping rules bite: `Bar` inside `foo.Baz` means
 * `foo.Baz.Bar` first, then `foo.Bar`, then `Bar` — innermost scope outward.
 * A leading dot means "absolute, skip the search".
 */
export function resolveType(reference, scope, index) {
	if (reference.startsWith(".")) {
		const absolute = reference.slice(1);
		return index.has(absolute) ? absolute : null;
	}
	const parts = scope ? scope.split(".") : [];
	for (let depth = parts.length; depth >= 0; depth -= 1) {
		const candidate = [...parts.slice(0, depth), reference].filter(Boolean).join(".");
		if (index.has(candidate)) return candidate;
	}
	return index.has(reference) ? reference : null;
}

/**
 * Walk every field of every message, including nested ones.
 *
 * The `scope` handed to the visitor is fully qualified, package included — the
 * same name `indexTypes` keys on and `protoc` prints. A visitor that sees a
 * bare `Customer.Address` cannot look that name up in the index, so the
 * qualification has to happen here rather than at each call site.
 */
export function walkFields(proto, prefix = "", visit = () => {}) {
	const base = prefix || proto.package || "";
	for (const message of proto.messages ?? []) {
		const full = base ? `${base}.${message.name}` : message.name;
		for (const field of message.fields ?? []) visit(field, full, message);
		walkFields({ messages: message.messages ?? [], enums: [] }, full, visit);
	}
}

/** Is `number` inside one of the (inclusive) reserved ranges? */
export function inRanges(number, ranges = []) {
	return ranges.some((range) => number >= range.from && number <= range.to);
}

/**
 * Protobuf's legal field numbers are 1..536870911 (2^29 - 1), minus the
 * 19000-19999 block that the implementation reserves for itself.
 */
export function checkFieldNumber(number) {
	if (!Number.isInteger(number)) return { ok: false, reason: "not an integer" };
	if (number < 1) return { ok: false, reason: "below 1" };
	if (number > 536870911) return { ok: false, reason: "above 536870911 (2^29-1)" };
	if (number >= RESERVED_BY_PROTOBUF.from && number <= RESERVED_BY_PROTOBUF.to) {
		return { ok: false, reason: `${RESERVED_BY_PROTOBUF.from}-${RESERVED_BY_PROTOBUF.to} is reserved by protobuf itself` };
	}
	return { ok: true };
}

/** Fields 1-15 cost one byte on the wire; 16+ cost two. Matters for hot paths. */
export function wireCost(number) {
	if (number <= 15) return { bytes: 1, tier: "compact" };
	if (number <= 2047) return { bytes: 2, tier: "normal" };
	return { bytes: 3, tier: "large" };
}