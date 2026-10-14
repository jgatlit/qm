import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createPrincipalLinkService, PrincipalLinkError, type PrincipalLink } from "../src/identity/principal-links.ts";
import { scopeId } from "../src/types.ts";
import type { AdminGrant } from "../src/admin/admin-service.ts";
import {
  applyLink,
  applyUnlink,
  checkLink,
  previewUnlink,
  type LinkOpsDeps,
} from "../scripts/lib/principal-link-ops.ts";

const WA = "wa:+17703126001";
const SLACK = "U097J6ZNWSX";
const ORG = scopeId("org", "acme");
const EVIDENCE = "verified owner of both the WhatsApp number and the Slack account";

function grant(principalId: string): AdminGrant {
  return { principalId, scopeId: ORG, role: "org_admin" };
}

async function setup(opts: { grants?: AdminGrant[]; members?: { principalId: string; slackId?: string }[] } = {}) {
  const links = createPrincipalLinkService(createMemoryMap<PrincipalLink>());
  const directory = createDirectoryStore();
  await directory.replace(
    (opts.members ?? []).map((m) => ({ displayName: m.principalId, type: "internal" as const, ...m })),
  );
  const grants = opts.grants ?? [grant(SLACK)];
  const audit = createAuditLog();
  const deps: LinkOpsDeps = {
    links,
    directory,
    grants: { all: async () => grants },
    audit,
    scopeLabel: ORG,
  };
  return { deps, links, audit };
}

const failing = (report: { checks: { name: string; ok: boolean }[] }) =>
  report.checks.filter((c) => !c.ok).map((c) => c.name);

describe("principal-link operator checks", () => {
  it("passes for an unknown sign-in and an admin canonical", async () => {
    const { deps } = await setup();
    const report = await checkLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE });
    assert.equal(report.ok, true);
    assert.equal(report.alreadyLinked, false);
  });

  it("refuses a linked side that is a directory member by principal id or Slack id", async () => {
    const { deps } = await setup({ members: [{ principalId: "jordan@acme.test", slackId: "U0JORDAN" }] });
    assert.deepEqual(failing(await checkLink(deps, { principalId: "jordan@acme.test", canonicalId: SLACK })), [
      "linked_side_not_directory_member",
    ]);
    assert.deepEqual(failing(await checkLink(deps, { principalId: "U0JORDAN", canonicalId: SLACK })), [
      "linked_side_not_directory_member",
    ]);
  });

  it("refuses a sign-in holding an admin grant unless the canonical is an admin", async () => {
    const { deps } = await setup({ grants: [grant(WA), grant("U0OTHER")] });
    const report = await checkLink(deps, { principalId: WA, canonicalId: SLACK });
    assert.deepEqual(failing(report), ["no_admin_escalation", "canonical_is_admin"]);
    const ok = await checkLink(deps, { principalId: WA, canonicalId: "U0OTHER" });
    assert.equal(ok.ok, true);
  });

  it("requires the canonical to be an admin", async () => {
    const { deps } = await setup({ grants: [grant("U0OTHER")] });
    assert.deepEqual(failing(await checkLink(deps, { principalId: WA, canonicalId: SLACK })), ["canonical_is_admin"]);
  });

  it("refuses empty or oversized evidence and self links", async () => {
    const { deps } = await setup();
    assert.deepEqual(failing(await checkLink(deps, { principalId: WA, canonicalId: SLACK, evidence: "  " })), [
      "evidence_present",
    ]);
    assert.deepEqual(
      failing(await checkLink(deps, { principalId: WA, canonicalId: SLACK, evidence: "x".repeat(501) })),
      ["evidence_present"],
    );
    assert.ok(failing(await checkLink(deps, { principalId: SLACK, canonicalId: SLACK })).includes("ids_valid"));
  });

  it("keeps links flat in both directions and refuses conflicting links", async () => {
    const { deps, links } = await setup({ grants: [grant(SLACK), grant("U0TWO")] });
    await links.link({ principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, linkedBy: SLACK });
    assert.deepEqual(failing(await checkLink(deps, { principalId: "x@y.test", canonicalId: WA })), [
      "canonical_is_admin",
      "canonical_not_an_alias",
    ]);
    assert.deepEqual(failing(await checkLink(deps, { principalId: SLACK, canonicalId: "U0TWO" })), [
      "linked_side_not_canonical_elsewhere",
    ]);
    assert.deepEqual(failing(await checkLink(deps, { principalId: WA, canonicalId: "U0TWO" })), [
      "no_conflicting_link",
    ]);
    const same = await checkLink(deps, { principalId: WA, canonicalId: SLACK });
    assert.equal(same.ok, true);
    assert.equal(same.alreadyLinked, true);
  });
});

describe("principal-link operator apply", () => {
  it("dry-run writes nothing: checkLink and previewUnlink never touch the store or audit log", async () => {
    const { deps, links, audit } = await setup();
    await checkLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK });
    assert.deepEqual(await links.list(), []);
    assert.deepEqual(await audit.events(), []);
    assert.equal(await previewUnlink(deps, WA), null);
  });

  it("apply links, stamps linkedBy, and audits as the --by admin", async () => {
    const { deps, links, audit } = await setup();
    const result = await applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK });
    assert.equal(result.created, true);
    assert.equal(result.auditRecorded, true);
    assert.equal(result.link.linkedBy, SLACK);
    assert.equal(links.canonical(WA), SLACK);
    const events = await audit.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.principalId, SLACK);
    assert.equal(events[0]!.action, "principal_link.create");
    assert.equal(events[0]!.resource, `${WA} -> ${SLACK}`);
    assert.equal(events[0]!.scopeLabel, ORG);
  });

  it("apply is idempotent and does not audit a second time", async () => {
    const { deps, audit } = await setup();
    await applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK });
    const again = await applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK });
    assert.equal(again.created, false);
    assert.equal((await audit.events()).length, 1);
  });

  it("apply refuses on a failed check and writes nothing", async () => {
    const { deps, links, audit } = await setup({ members: [{ principalId: WA }] });
    await assert.rejects(
      applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK }),
      (e: unknown) => e instanceof PrincipalLinkError && /linked_side_not_directory_member/.test(e.message),
    );
    assert.deepEqual(await links.list(), []);
    assert.deepEqual(await audit.events(), []);
  });

  it("apply requires --by to be an org admin", async () => {
    const { deps, links } = await setup();
    await assert.rejects(applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE }), /--by/);
    await assert.rejects(
      applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: "U0NOTADMIN" }),
      /does not hold an org admin grant/,
    );
    assert.deepEqual(await links.list(), []);
  });

  it("unlink removes the row and audits principal_link.delete", async () => {
    const { deps, links, audit } = await setup();
    await applyLink(deps, { principalId: WA, canonicalId: SLACK, evidence: EVIDENCE, by: SLACK });
    const result = await applyUnlink(deps, WA);
    assert.equal(result.link?.principalId, WA);
    assert.equal(result.auditRecorded, true);
    assert.equal(links.canonical(WA), undefined);
    assert.deepEqual(
      (await audit.events()).map((e) => e.action),
      ["principal_link.create", "principal_link.delete"],
    );
    assert.equal((await applyUnlink(deps, WA)).link, null);
  });
});
