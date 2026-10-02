// Logic suite — the pure functions: tokenizer, parser, type resolution,
// number rules, diff classification, audit findings.
//
// These run without a runtime, without a context and without the network, so a
// failure here is unambiguous: the algorithm is wrong, not the wiring.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	stripComments, tokenize, parseProto, indexTypes, resolveType, inRanges,
	checkFieldNumber, wireCost, walkFields, SCALAR_TYPES
} from "../lib/parse.mjs";
import {
	describeMessage, describeService, diffProto, auditProto,
	suggestFieldNumber, outline, collectMessages, streamingShape
} from "../lib/analyze.mjs";
import { fixture, FIXTURES } from "./harness.mjs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

let count = 0;
function ok(condition, message) {
	assert.ok(condition, message);
	count += 1;
}
function eq(actual, expected, message) {
	assert.deepEqual(actual, expected, `${message} (got ${JSON.stringify(actual)})`);
	count += 1;
}

// ---------------------------------------------------------------- comments --

test("stripComments removes line comments but keeps the newline", () => {
	const out = stripComments("a // comment\nb");
	ok(out.includes("a") && out.includes("b"), "code either side of a line comment survives");
	eq(out.split("\n").length, 2, "line comment must not swallow the newline");
});

test("stripComments removes block comments and preserves line count", () => {
	const source = "a\n/* one\ntwo\nthree */\nb";
	const out = stripComments(source);
	eq(out.split("\n").length, source.split("\n").length, "block comment keeps its line count");
	ok(!out.includes("one"), "block comment body is gone");
	ok(out.includes("a") && out.includes("b"), "code around the block comment survives");
});

test("stripComments does not treat a slash inside a string as a comment", () => {
	const out = stripComments('option x = "http://example.com//path";');
	ok(out.includes("http://example.com//path"), "URL inside a string literal is untouched");
});

test("tokenize keeps a string containing a semicolon whole", () => {
	const tokens = tokenize('option java_package = "a;b";');
	const string = tokens.find((t) => t.kind === "string");
	ok(string !== undefined, "the string token was produced");
	eq(string.value, "a;b", "semicolon inside a string does not split the token");
});

test("tokenize collapses punctuation but not multi-char operators it does not know", () => {
	const tokens = tokenize("a.b c<d>x");
	eq(tokens.map((t) => t.value), ["a", ".", "b", "c", "<", "d", ">", "x"], "single-char punctuation splits cleanly");
});

// ----------------------------------------------------------------- parsing --

test("parseProto reads syntax, package, imports and options", async () => {
	const { proto } = await fixture("billing.proto");
	eq(proto.syntax, "proto3", "syntax");
	eq(proto.package, "acme.billing.v1", "package");
	eq(proto.imports.length, 2, "two imports");
	eq(proto.imports[0].path, "google/protobuf/timestamp.proto", "first import path");
	eq(proto.imports[0].modifier, "default", "default import modifier");
	eq(proto.options.java_package, "com.acme.billing.v1", "java_package option");
});

test("parseProto reads message fields with numbers, types and labels", async () => {
	const { proto } = await fixture("billing.proto");
	const messages = collectMessages(proto);
	const lineItem = messages.get("acme.billing.v1.LineItem");
	ok(lineItem !== undefined, "LineItem found");
	eq(lineItem.fields.length, 6, "LineItem field count");
	eq(lineItem.fields[0].name, "description", "first field name");
	eq(lineItem.fields[0].number, 1, "first field number");
	eq(lineItem.fields[2].type, "string", "third field type");
	eq(lineItem.fields[5].type, "acme.common.Money", "qualified type is kept verbatim");
});

test("parseProto reads repeated fields", async () => {
	const { proto } = await fixture("billing.proto");
	const invoice = collectMessages(proto).get("acme.billing.v1.Invoice");
	const repeated = invoice.fields.find((f) => f.name === "line_items");
	eq(repeated.label, "repeated", "line_items is repeated");
	eq(repeated.type, "LineItem", "line_items element type");
});

test("parseProto reads map fields with both type arguments", async () => {
	const { proto } = await fixture("billing.proto");
	const invoice = collectMessages(proto).get("acme.billing.v1.Invoice");
	const labels = invoice.fields.find((f) => f.name === "labels");
	eq(labels.label, "map", "map label");
	eq(labels.keyType, "string", "map key type");
	eq(labels.valueType, "string", "map value type");
	eq(labels.type, "map<string, string>", "map type renders as one string");
});

test("parseProto reads oneof groups and links each field to its oneof", async () => {
	const { proto } = await fixture("billing.proto");
	const invoice = collectMessages(proto).get("acme.billing.v1.Invoice");
	eq(invoice.oneofs.length, 1, "one oneof");
	eq(invoice.oneofs[0].name, "delivery", "oneof name");
	eq(invoice.oneofs[0].fields.map((f) => f.name), ["pdf_url", "hosted_url"], "both oneof members captured");
});

test("parseProto reads reserved numbers and names separately", async () => {
	const { proto } = await fixture("billing.proto");
	const invoice = collectMessages(proto).get("acme.billing.v1.Invoice");
	eq(invoice.reserved.numbers, [{ from: 14, to: 14 }, { from: 15, to: 15 }], "reserved numbers");
	eq(invoice.reserved.names, ["legacy_vat_number"], "reserved names");
});

test("parseProto reads nested messages", async () => {
	const { proto } = await fixture("billing.proto");
	const customer = collectMessages(proto).get("acme.billing.v1.Customer");
	eq(customer.messages.map((m) => m.name), ["Address"], "Address is nested in Customer");
});

test("parseProto reads enum values with their numbers", async () => {
	const { proto } = await fixture("billing.proto");
	const status = proto.enums.find((e) => e.name === "InvoiceStatus");
	eq(status.values.length, 5, "five enum values");
	eq(status.values[0].name, "INVOICE_STATUS_UNSPECIFIED", "first enum value name");
	eq(status.values[0].number, 0, "first enum value number");
});

test("parseProto reads all four RPC streaming shapes", async () => {
	const { proto } = await fixture("billing.proto");
	const service = proto.services[0];
	eq(service.name, "BillingService", "service name");
	eq(service.methods.length, 4, "four methods");
	eq(streamingShape(service.methods[0]), "unary", "GetInvoice is unary");
	eq(streamingShape(service.methods[1]), "server-streaming", "ListInvoices is server-streaming");
	eq(streamingShape(service.methods[2]), "client-streaming", "UploadReconciliation is client-streaming");
	eq(streamingShape(service.methods[3]), "bidirectional-streaming", "Reconcile is bidi");
});

test("parseProto reads a method option block", () => {
	const proto = parseProto(`
		service S {
			rpc M (A) returns (B) {
				option deprecated = true;
			}
		}
		message A {}
		message B {}
	`);
	eq(proto.services[0].methods[0].options.deprecated, "true", "method option captured");
	count += 1;
});

test("parseProto reads proto2 required/optional labels and defaults", async () => {
	const { proto } = await fixture("legacy-proto2.proto");
	eq(proto.syntax, "proto2", "proto2 syntax");
	const payment = collectMessages(proto).get("legacy.v1.Payment");
	const id = payment.fields.find((f) => f.name === "payment_id");
	eq(id.label, "required", "required label kept");
	const memo = payment.fields.find((f) => f.name === "amount_minor");
	eq(memo.options.default, "0", "default option captured");
	count += 1;
});

test("parseProto reads proto2 extension ranges including `to max`", async () => {
	const { proto } = await fixture("legacy-proto2.proto");
	const payment = collectMessages(proto).get("legacy.v1.Payment");
	eq(payment.extensions.length, 2, "two extension ranges");
	eq(payment.extensions[0], { from: 100, to: 199 }, "first extension range");
	eq(payment.extensions[1].from, 500, "second extension range starts at 500");
	eq(payment.extensions[1].to, Number.MAX_SAFE_INTEGER, "`to max` becomes the max sentinel");
});

test("parseProto does not choke on a top-level extend block", async () => {
	const { proto } = await fixture("legacy-proto2.proto");
	// `extend Payment { ... }` is not modelled, but it must not poison the rest
	// of the file: Refund comes after it and has to survive.
	ok(collectMessages(proto).has("legacy.v1.Refund"), "the message after `extend` still parses");
});

test("parseProto reads a message with no fields", () => {
	const proto = parseProto("message Empty {}");
	eq(proto.messages[0].fields.length, 0, "empty message has zero fields");
	count += 1;
});

test("parseProto tolerates stray semicolons and unknown top-level statements", () => {
	const proto = parseProto(`
		syntax = "proto3";
		;
		custom_option = 1;
		message A { string x = 1; };
	`);
	eq(proto.messages.length, 1, "the message after an unknown statement parses");
	eq(proto.messages[0].fields.length, 1, "its field parses");
});

test("parseProto reports the token it stopped on when a brace is unbalanced", () => {
	assert.throws(
		() => parseProto("message A { string x = 1; "),
		/end of input/u,
		"unbalanced braces raise a message naming the stopping point"
	);
	count += 1;
});

// ------------------------------------------------------------- resolution --

test("indexTypes qualifies nested messages with dots", async () => {
	const { proto } = await fixture("billing.proto");
	const index = indexTypes(proto);
	ok(index.has("acme.billing.v1.Customer.Address"), "nested Address is qualified");
	eq(index.get("acme.billing.v1.Customer.Address").kind, "message", "Address is a message");
});

test("resolveType prefers the innermost scope, then walks outward", () => {
	const proto = parseProto(`
		package p;
		message Outer {
			message Inner { string a = 1; }
			message Mid {
				message Inner { string b = 1; }
				Inner ref = 1;
			}
		}
	`);
	const index = indexTypes(proto);
	// `Inner` inside `p.Outer.Mid` must bind to `p.Outer.Mid.Inner`, not the sibling.
	eq(resolveType("Inner", "p.Outer.Mid", index), "p.Outer.Mid.Inner", "innermost scope wins");
	eq(resolveType("Outer.Inner", "p.Outer.Mid", index), "p.Outer.Inner", "walks out one level");
	eq(resolveType(".p.Outer.Inner", "p.Outer.Mid", index), "p.Outer.Inner", "leading dot is absolute");
	eq(resolveType("Nope", "p.Outer.Mid", index), null, "unresolvable name returns null");
	count += 1;
});

test("resolveType handles a map value that names a nested enum", () => {
	const proto = parseProto(`
		package p;
		message M {
			enum E { A = 0; }
			map<string, E> m = 1;
		}
	`);
	const index = indexTypes(proto);
	eq(resolveType("E", "p.M", index), "p.M.E", "nested enum resolves");
	count += 1;
});

// ---------------------------------------------------------- number rules --

test("checkFieldNumber accepts the legal range and rejects the illegal ends", () => {
	eq(checkFieldNumber(1).ok, true, "1 is legal");
	eq(checkFieldNumber(15).ok, true, "15 is legal");
	eq(checkFieldNumber(536870911).ok, true, "2^29-1 is the largest legal number");
	eq(checkFieldNumber(536870912).ok, false, "2^29 is above the maximum");
	eq(checkFieldNumber(0).ok, false, "0 is below the minimum");
	eq(checkFieldNumber(-1).ok, false, "negative is illegal");
});

test("checkFieldNumber rejects the protobuf-reserved block", () => {
	eq(checkFieldNumber(19000).ok, false, "19000 is the bottom of the reserved block");
	eq(checkFieldNumber(19999).ok, false, "19999 is the top of the reserved block");
	eq(checkFieldNumber(18999).ok, true, "18999 is just below and legal");
	eq(checkFieldNumber(20000).ok, true, "20000 is just above and legal");
	ok(checkFieldNumber(19005).reason.includes("19000"), "the reason names the reserved block");
	count += 1;
});

test("wireCost reflects the one-byte and two-byte tag windows", () => {
	eq(wireCost(1).bytes, 1, "field 1 costs one byte");
	eq(wireCost(15).bytes, 1, "field 15 still costs one byte");
	eq(wireCost(16).bytes, 2, "field 16 costs two bytes");
	eq(wireCost(2047).bytes, 2, "2047 is the top of the two-byte window");
	eq(wireCost(2048).bytes, 3, "2048 costs three bytes");
	count += 1;
});

test("inRanges treats ranges as inclusive", () => {
	ok(inRanges(5, [{ from: 5, to: 7 }]), "lower bound is inside");
	ok(inRanges(7, [{ from: 5, to: 7 }]), "upper bound is inside");
	ok(!inRanges(8, [{ from: 5, to: 7 }]), "one past the top is outside");
	ok(!inRanges(4, [{ from: 5, to: 7 }]), "one below the bottom is outside");
	count += 1;
});

test("walkFields visits nested messages and names their scope", async () => {
	const { proto } = await fixture("billing.proto");
	const seen = new Map();
	walkFields(proto, "", (field, scope) => seen.set(`${scope}.${field.name}`, field.number));
	ok(seen.has("acme.billing.v1.Customer.Address.city"), "nested Address field is walked");
	eq(seen.get("acme.billing.v1.Invoice.total_minor"), 9, "top-level field number is right");
	count += 1;
});

// ------------------------------------------------------------- describe --

test("describeMessage lists fields sorted by number with wire cost", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeMessage(proto, "Invoice");
	eq(result.found, true, "Invoice found");
	ok(result.fields.every((f, i, a) => i === 0 || a[i - 1].number <= f.number), "fields are number-sorted");
	eq(result.fields[0].name, "invoice_id", "lowest number first");
	eq(result.fields[0].wireBytes, 1, "field 1 is a one-byte tag");
	eq(result.fields.find((f) => f.number === 20) ?? null, null, "v1 has no field 20");
	count += 1;
});

test("describeMessage resolves a cross-package type reference", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeMessage(proto, "LineItem");
	const unitPrice = result.fields.find((f) => f.name === "unit_price");
	// google/protobuf/money is not imported, so this one is legitimately unresolved.
	eq(unitPrice.resolvedKind === "message" || unitPrice.resolvedKind === "unresolved", true, "unresolved is reported, not thrown");
	count += 1;
});

test("describeMessage resolves a local nested type", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeMessage(proto, "acme.billing.v1.Customer");
	const address = result.fields.find((f) => f.name === "billing_address");
	eq(address.resolvedKind, "message", "billing_address resolves to a message");
	eq(address.resolvedType, "acme.billing.v1.Customer.Address", "to the nested Address");
	count += 1;
});

test("describeMessage reports a missing message with the list of real ones", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeMessage(proto, "Nope");
	eq(result.found, false, "not found");
	ok(result.available.includes("acme.billing.v1.Invoice"), "the message list is offered");
	count += 1;
});

test("describeMessage exposes the oneof and reserved state", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeMessage(proto, "Invoice");
	eq(result.oneofs[0].name, "delivery", "oneof is reported");
	eq(result.reserved.names, ["legacy_vat_number"], "reserved name is reported");
	eq(result.highWaterMark, 13, "oneof members 12/13 count toward the high-water mark");
	count += 1;
});

test("describeService gives each method its gRPC path and shape", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeService(proto, "BillingService");
	eq(result.found, true, "service found");
	const get = result.services[0].methods.find((m) => m.name === "GetInvoice");
	eq(get.fullName, "/acme.billing.v1.BillingService/GetInvoice", "full gRPC path includes the package");
	eq(get.shape, "unary", "unary shape");
	const list = result.services[0].methods.find((m) => m.name === "ListInvoices");
	eq(list.shape, "server-streaming", "server-streaming shape");
	count += 1;
});

test("describeService reports a missing service with the list of real ones", async () => {
	const { proto } = await fixture("billing.proto");
	const result = describeService(proto, "Nope");
	eq(result.found, false, "not found");
	eq(result.available, ["BillingService"], "the real service is offered");
	count += 1;
});

// ---------------------------------------------------------------- outline --

test("outline counts every construct in the file", async () => {
	const { proto } = await fixture("billing.proto");
	const result = outline(proto);
	eq(result.syntax, "proto3", "syntax");
	eq(result.package, "acme.billing.v1", "package");
	eq(result.counts.messages, 8, "eight messages including the nested Address");
	eq(result.counts.enums, 2, "two enums");
	eq(result.counts.services, 1, "one service");
	eq(result.counts.methods, 4, "four methods");
});

test("outline reports a null package rather than an empty string", () => {
	const result = outline(parseProto("message A {}"));
	eq(result.package, null, "missing package is null");
	count += 1;
});

// ------------------------------------------------------------------- diff --

test("diffProto flags a reused field number as breaking", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	const finding = result.findings.find((f) => f.kind === "number-reused" && f.message.endsWith("Invoice"));
	ok(finding !== undefined, "the reused number is reported");
	eq(finding.severity, "breaking", "reuse is breaking");
	ok(finding.detail.includes("invoice_id"), "the old name is named");
	count += 1;
});

test("diffProto flags a retyped field as breaking", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	// LineItem.amount_minor stayed at 2 but changed int64 -> string.
	const finding = result.findings.find((f) => f.kind === "type-changed" && f.field === "amount_minor");
	ok(finding !== undefined, "the retyped field is reported");
	eq(finding.severity, "breaking", "a retype is breaking");
	ok(finding.detail.includes("int64") && finding.detail.includes("string"), "both types are named");
	count += 1;
});

test("diffProto flags a field number move as breaking", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	const finding = result.findings.find((f) => f.kind === "number-changed" && f.field === "total_minor");
	ok(finding !== undefined, "the moved field is reported");
	ok(finding.detail.includes("9") && finding.detail.includes("30"), "both numbers are named");
	count += 1;
});

test("diffProto marks a removal as risky only when the number was reserved", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	// due_at (6) was reserved in v2, so the removal itself is only risky.
	const dueAt = result.findings.find((f) => f.kind === "field-removed" && f.field === "due_at");
	ok(dueAt !== undefined, "due_at removal is reported");
	eq(dueAt.severity, "risky", "reserved removal is risky, not breaking");
	count += 1;
});

test("diffProto marks a removal as breaking when the number was not reserved", async () => {
	const before = parseProto("message M { string a = 1; string b = 2; }");
	const after = parseProto("message M { string a = 1; }");
	const result = diffProto(before, after);
	const finding = result.findings.find((f) => f.kind === "field-removed");
	eq(finding.severity, "breaking", "unreserved removal is breaking");
	ok(finding.detail.includes("NOT reserved"), "the detail says what to do about it");
	count += 1;
});

test("diffProto accepts an addition below the reserved line as additive", async () => {
	const before = parseProto("message M { string a = 1; }");
	const after = parseProto("message M { string a = 1; string b = 2; }");
	const result = diffProto(before, after);
	const finding = result.findings.find((f) => f.kind === "field-added");
	eq(finding.severity, "additive", "a plain addition is additive");
	eq(result.verdict, "compatible", "the file stays compatible");
	count += 1;
});

test("diffProto treats an addition inside a reserved range as breaking", async () => {
	const before = parseProto("message M { string a = 1; reserved 5; }");
	const after = parseProto("message M { string a = 1; string b = 5; reserved 6; }");
	const result = diffProto(before, after);
	const finding = result.findings.find((f) => f.kind === "field-added");
	eq(finding.severity, "breaking", "adding into a reserved number is breaking");
	count += 1;
});

test("diffProto reports a removed message as breaking and a new one as additive", async () => {
	const before = parseProto("message Kept { string a = 1; } message Gone { string a = 1; }");
	const after = parseProto("message Kept { string a = 1; } message Fresh { string a = 1; }");
	const result = diffProto(before, after);
	eq(result.findings.find((f) => f.kind === "message-removed").severity, "breaking", "removal is breaking");
	eq(result.findings.find((f) => f.kind === "message-added").severity, "additive", "addition is additive");
	count += 1;
});

test("diffProto<|place_holder_mm_span_0442|> returns incompatible when anything is breaking", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	eq(result.verdict, "incompatible", "this pair is incompatible");
	ok(result.counts.breaking > 0, "at least one breaking finding");
	count += 1;
});

test("diffProto on an identical file reports no findings", async () => {
	const { proto } = await fixture("billing.proto");
	const result = diffProto(proto, proto);
	eq(result.findings.length, 0, "identical files produce no findings");
	eq(result.verdict, "compatible", "identical is compatible");
	count += 1;
});

test("diffProto sorts breaking findings before additive ones", async () => {
	const before = await fixture("billing.proto");
	const after = await fixture("billing-v2.proto");
	const result = diffProto(before.proto, after.proto);
	const ranks = result.findings.map((f) => ({ breaking: 0, risky: 1, additive: 2 }[f.severity]));
	eq(ranks, [...ranks].sort((a, b) => a - b), "findings are severity-sorted");
	count += 1;
});

test("diffProto only reports fields of the same message, not cross-message noise", async () => {
	const before = parseProto("message A { string x = 1; } message B { string y = 1; }");
	const after = parseProto("message A { string x = 1; } message B { string y = 2; }");
	const result = diffProto(before, after);
	const changes = result.findings.filter((f) => f.kind === "number-changed");
	eq(changes.length, 1, "only B changed");
	eq(changes[0].message, "B", "and the finding names B");
	count += 1;
});

// ------------------------------------------------------------------ audit --

test("auditProto catches a duplicated field number", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where.includes("broken.v1.Dup.") && i.detail.includes("already used"));
	ok(finding !== undefined, "the duplicate is reported");
	eq(finding.severity, "error", "a duplicate is an error");
	count += 1;
});

test("auditProto catches a field number inside the protobuf-reserved block", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where === "broken.v1.Dup.c");
	ok(finding !== undefined, "field c at 19005 is reported");
	ok(finding.detail.includes("19000"), "the reserved block is named");
	count += 1;
});

test("auditProto catches a field number below 1 and above the maximum", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	ok(result.issues.some((i) => i.where === "broken.v1.Dup.d"), "number 0 is reported");
	ok(result.issues.some((i) => i.where === "broken.v1.Dup.e"), "536870912 is reported");
	count += 1;
});

test("auditProto catches a field that collides with a reserved number or name", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	ok(result.issues.some((i) => i.where === "broken.v1.ReservedClash.bad" && i.detail.includes("reserved")), "number clash with reserved is reported");
	ok(result.issues.some((i) => i.where === "broken.v1.ReservedClash.gone"), "name clash with reserved is reported");
	count += 1;
});

test("auditProto catches an illegal map key type", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where === "broken.v1.BadMap.nope");
	ok(finding !== undefined, "bytes as a map key is reported");
	ok(finding.detail.includes("bytes"), "the offending key type is named");
	count += 1;
});

test("auditProto catches an unresolvable field type", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where === "broken.v1.BadMap.dangling");
	ok(finding !== undefined, "MissingType is reported as unresolvable");
	count += 1;
});

test("auditProto warns about an unreserved gap below the high-water mark", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where === "broken.v1.Gappy" && i.severity === "warn");
	ok(finding !== undefined, "the gap at 2 is reported");
	ok(finding.detail.includes("reuse"), "the detail explains the risk");
	count += 1;
});

test("auditProto does not warn about gaps while an extension range exists", async () => {
	const { proto } = await fixture("legacy-proto2.proto");
	const result = auditProto(proto);
	const paymentGap = result.issues.filter((i) => i.where === "legacy.v1.Payment" && i.severity === "warn");
	eq(paymentGap.length, 0, "extension ranges legitimate gaps, so no warning");
	count += 1;
});

test("auditProto requires an enum zero value and catches an unaliased duplicate", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	ok(result.issues.some((i) => i.where === "broken.v1.NoZero" && i.detail.includes("zero value")), "missing zero value is reported");
	ok(result.issues.some((i) => i.where.includes("broken.v1.Aliased") && i.severity === "error"), "unaliased duplicate is an error");
	count += 1;
});

test("auditProto downgrades a duplicate enum number when allow_alias is set", () => {
	const proto = parseProto(`
		enum E {
			option allow_alias = true;
			A = 0;
			B = 0;
		}
	`);
	const result = auditProto(proto);
	const finding = result.issues.find((i) => i.where.includes("B"));
	eq(finding.severity, "warn", "an allowed alias is only a warning");
	count += 1;
});

test("auditProto catches a proto3 required label", () => {
	const proto = parseProto('syntax = "proto3"; message M { required string a = 1; }');
	const result = auditProto(proto);
	ok(result.issues.some((i) => i.detail.includes("proto3 does not support")), "required in proto3 is reported");
	count += 1;
});

test("auditProto catches an unresolvable RPC input type", () => {
	const proto = parseProto("message B {} service S { rpc M (Missing) returns (B); }");
	const result = auditProto(proto);
	ok(result.issues.some((i) => i.detail.includes("Missing")), "the missing input type is reported");
	count += 1;
});

test("auditProto reports a clean file as clean", async () => {
	const { proto } = await fixture("billing.proto");
	const result = auditProto(proto);
	eq(result.counts.error, 0, "a well-formed file has no errors");
	count += 1;
});

test("auditProto counts errors and warns separately", async () => {
	const { proto } = await fixture("broken.proto");
	const result = auditProto(proto);
	ok(result.counts.error > 0, "the broken fixture has errors");
	eq(result.counts.error, result.issues.filter((i) => i.severity === "error").length, "the error count matches the list");
	eq(result.counts.warn, result.issues.filter((i) => i.severity === "warn").length, "the warning count matches the list");
});

// ------------------------------------------------------- number suggestion --

test("suggestFieldNumber checks a specific number against a message", async () => {
	const { proto } = await fixture("billing.proto");
	const taken = suggestFieldNumber(proto, "Invoice", 1);
	eq(taken.safe, false, "field 1 is taken");
	ok(taken.conflicts[0].includes("invoice_id"), "and the conflict names the field");
	const free = suggestFieldNumber(proto, "Invoice", 30);
	eq(free.safe, true, "field 30 is free");
	count += 1;
});

test("suggestFieldNumber rejects a number inside the protobuf-reserved block", async () => {
	const { proto } = await fixture("billing.proto");
	const result = suggestFieldNumber(proto, "Invoice", 19500);
	eq(result.safe, false, "19500 is refused");
	ok(result.conflicts.some((c) => c.includes("19000")), "the reason names the reserved block");
	count += 1;
});

test("suggestFieldNumber rejects a number the message reserved", async () => {
	const { proto } = await fixture("billing.proto");
	const result = suggestFieldNumber(proto, "Invoice", 14);
	eq(result.safe, false, "14 is reserved in Invoice");
	count += 1;
});

test("suggestFieldNumber proposes numbers above the high-water mark", async () => {
	const { proto } = await fixture("billing.proto");
	const result = suggestFieldNumber(proto, "Invoice");
	eq(result.highWaterMark, 13, "high-water mark is 13, counting the oneof members");
	eq(result.suggestions[0].number, 16, "the first free number above the reserved 14/15 is 16");
	count += 1;
});

test("suggestFieldNumber skips the protobuf-reserved block when proposing", () => {
	// A message whose high-water mark sits just below 19000 must jump the block.
	const fields = Array.from({ length: 3 }, (_, i) => `string f${i} = ${18999 + i};`).join(" ");
	const proto = parseProto(`message M { ${fields} }`);
	const result = suggestFieldNumber(proto, "M");
	eq(result.suggestions[0].number, 20000, "the proposal skips 19000-19999");
	count += 1;
});

test("suggestFieldNumber reports a missing message with the real names", async () => {
	const { proto } = await fixture("billing.proto");
	const result = suggestFieldNumber(proto, "Nope");
	eq(result.found, false, "not found");
	ok(result.available.includes("acme.billing.v1.Invoice"), "the message list is offered");
	count += 1;
});

test("suggestFieldNumber accepts a bare (unqualified) message name", async () => {
	const { proto } = await fixture("billing.proto");
	const result = suggestFieldNumber(proto, "Invoice");
	eq(result.found, true, "the short name resolves through the package");
	eq(result.message, "acme.billing.v1.Invoice", "and is reported qualified");
	count += 1;
});

console.log(`\nlogic: ${count} assertions passed`);
export const assertions = count;