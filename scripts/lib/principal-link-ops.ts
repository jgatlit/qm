import { adminStatusFromGrants, type AdminGrant } from "../../src/admin/admin-service.ts";
import type { AuditLog } from "../../src/audit/audit-log.ts";
import { foldPrincipalId, samePerson } from "../../src/directory/person.ts";
import type { DirectoryMember } from "../../src/directory/directory-store.ts";
import {
  PrincipalLinkError,
  type PrincipalLink,
  type PrincipalLinkService,
} from "../../src/identity/principal-links.ts";
import type { ScopeId } from "../../src/types.ts";
import { errMessage } from "../../src/util/errors.ts";

const CREATE_ACTION = "principal_link.create";
const DELETE_ACTION = "principal_link.delete";
const AUDIT_DETAIL = "operator CLI scripts/principal-link.ts";
const MAX_ID_LENGTH = 255;
const MAX_EVIDENCE_LENGTH = 500;

export interface LinkOpsDeps {
  links: PrincipalLinkService;
  directory: { list(): Promise<DirectoryMember[]> };
  grants: { all(): Promise<AdminGrant[]> };
  audit: AuditLog;
  scopeLabel: ScopeId;
  now?: () => number;
}

interface LinkCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LinkReport {
  principalId: string;
  canonicalId: string;
  checks: LinkCheck[];
  ok: boolean;
  alreadyLinked: boolean;
}

export interface LinkRequest {
  principalId: string;
  canonicalId: string;
  evidence?: string;
  by?: string;
}

function check(name: string, ok: boolean, detail: string): LinkCheck {
  return { name, ok, detail };
}

function validId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH;
}

function memberMatching(members: readonly DirectoryMember[], id: string): DirectoryMember | undefined {
  const trimmed = id.trim();
  return members.find((m) => samePerson(m.principalId, trimmed) || m.slackId === trimmed);
}

export async function checkLink(deps: LinkOpsDeps, request: LinkRequest): Promise<LinkReport> {
  const principalId = request.principalId.trim();
  const canonicalId = request.canonicalId.trim();
  const checks: LinkCheck[] = [];
  const idsValid = validId(principalId) && validId(canonicalId);
  const sameId = idsValid && foldPrincipalId(principalId) === foldPrincipalId(canonicalId);
  let idsDetail = "both ids are non-empty and distinct";
  if (!idsValid) idsDetail = `ids must be non-empty and at most ${MAX_ID_LENGTH} characters`;
  else if (sameId) idsDetail = "a principal cannot be linked to itself";
  checks.push(check("ids_valid", idsValid && !sameId, idsDetail));
  if (request.evidence !== undefined) {
    const evidence = request.evidence.trim();
    checks.push(
      check(
        "evidence_present",
        evidence.length > 0 && evidence.length <= MAX_EVIDENCE_LENGTH,
        evidence.length > 0 && evidence.length <= MAX_EVIDENCE_LENGTH
          ? `${evidence.length} characters`
          : `evidence must be 1-${MAX_EVIDENCE_LENGTH} characters, got ${evidence.length}`,
      ),
    );
  }

  const [members, grants, existingLinks] = await Promise.all([
    deps.directory.list(),
    deps.grants.all(),
    deps.links.list(),
  ]);

  const member = memberMatching(members, principalId);
  checks.push(
    check(
      "linked_side_not_directory_member",
      !member,
      member
        ? `${principalId} is a directory member (${member.principalId}); directory members stay canonical`
        : `${principalId} is not a directory member by principal id or Slack id`,
    ),
  );

  const principalAdmin = adminStatusFromGrants(grants, principalId).isAdmin;
  const canonicalAdmin = adminStatusFromGrants(grants, canonicalId).isAdmin;
  let escalationDetail = `${principalId} holds no admin grant`;
  if (principalAdmin) {
    escalationDetail = canonicalAdmin
      ? `${principalId} holds an admin grant and ${canonicalId} is an admin`
      : `${principalId} holds an admin grant but ${canonicalId} is not an admin`;
  }
  checks.push(check("no_admin_escalation", !principalAdmin || canonicalAdmin, escalationDetail));
  checks.push(
    check(
      "canonical_is_admin",
      canonicalAdmin,
      canonicalAdmin ? `${canonicalId} holds an org admin grant` : `${canonicalId} holds no org admin grant`,
    ),
  );

  const principalKey = foldPrincipalId(principalId);
  const canonicalKey = foldPrincipalId(canonicalId);
  const existing = existingLinks.find((l) => foldPrincipalId(l.principalId) === principalKey);
  const alreadyLinked = !!existing && foldPrincipalId(existing.canonicalId) === canonicalKey;
  let conflictDetail = `${principalId} has no existing link`;
  if (existing) {
    conflictDetail = alreadyLinked
      ? `${principalId} is already linked to ${canonicalId}; apply is a no-op`
      : `${principalId} is already linked to ${existing.canonicalId}`;
  }
  checks.push(check("no_conflicting_link", !existing || alreadyLinked, conflictDetail));
  const canonicalAlias = existingLinks.find((l) => foldPrincipalId(l.principalId) === canonicalKey);
  checks.push(
    check(
      "canonical_not_an_alias",
      !canonicalAlias,
      canonicalAlias
        ? `${canonicalId} is itself linked to ${canonicalAlias.canonicalId}`
        : `${canonicalId} is not linked to any other principal`,
    ),
  );
  const dependents = existingLinks.filter((l) => foldPrincipalId(l.canonicalId) === principalKey);
  checks.push(
    check(
      "linked_side_not_canonical_elsewhere",
      dependents.length === 0,
      dependents.length
        ? `${principalId} is the canonical principal of ${dependents.length} other link(s)`
        : `${principalId} is not the canonical principal of any link`,
    ),
  );

  return { principalId, canonicalId, checks, ok: checks.every((c) => c.ok), alreadyLinked };
}

export interface ApplyResult {
  link: PrincipalLink;
  created: boolean;
  auditRecorded: boolean;
}

async function requireAdminActor(deps: LinkOpsDeps, by: string | undefined): Promise<string> {
  const actor = by?.trim();
  if (!actor) throw new PrincipalLinkError(400, "--by <adminId> is required to apply");
  if (!adminStatusFromGrants(await deps.grants.all(), actor).isAdmin)
    throw new PrincipalLinkError(403, `${actor} does not hold an org admin grant`);
  return actor;
}

async function auditPersisted(deps: LinkOpsDeps, action: string, resource: string, since: number): Promise<boolean> {
  const rows = await deps.audit.tail({ limit: 1, action, since, resourceContains: resource });
  return rows.length > 0;
}

export async function applyLink(deps: LinkOpsDeps, request: LinkRequest): Promise<ApplyResult> {
  const actor = await requireAdminActor(deps, request.by);
  const report = await checkLink(deps, request);
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length)
    throw new PrincipalLinkError(400, `refused: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  if (report.alreadyLinked) {
    const link = (await deps.links.list()).find(
      (l) => foldPrincipalId(l.principalId) === foldPrincipalId(report.principalId),
    );
    if (!link) throw new PrincipalLinkError(409, "link vanished during apply");
    return { link, created: false, auditRecorded: false };
  }
  const startedAt = (deps.now ?? Date.now)();
  const link = await deps.links.link({
    principalId: report.principalId,
    canonicalId: report.canonicalId,
    evidence: request.evidence,
    linkedBy: actor,
  });
  const resource = `${link.principalId} -> ${link.canonicalId}`;
  deps.audit.record({
    at: (deps.now ?? Date.now)(),
    principalId: actor,
    action: CREATE_ACTION,
    resource,
    scopeLabel: deps.scopeLabel,
    detail: AUDIT_DETAIL,
  });
  return { link, created: true, auditRecorded: await auditPersisted(deps, CREATE_ACTION, resource, startedAt) };
}

export interface UnlinkResult {
  link: PrincipalLink | null;
  auditRecorded: boolean;
}

export async function previewUnlink(deps: LinkOpsDeps, principalId: string): Promise<PrincipalLink | null> {
  const key = foldPrincipalId(principalId);
  return (await deps.links.list()).find((l) => foldPrincipalId(l.principalId) === key) ?? null;
}

export async function applyUnlink(deps: LinkOpsDeps, principalId: string, by?: string): Promise<UnlinkResult> {
  const existing = await previewUnlink(deps, principalId);
  if (!existing) return { link: null, auditRecorded: false };
  const actor = await requireAdminActor(deps, by ?? existing.linkedBy);
  const startedAt = (deps.now ?? Date.now)();
  const link = await deps.links.unlink(principalId.trim());
  if (!link) return { link: null, auditRecorded: false };
  const resource = `${link.principalId} -> ${link.canonicalId}`;
  deps.audit.record({
    at: (deps.now ?? Date.now)(),
    principalId: actor,
    action: DELETE_ACTION,
    resource,
    scopeLabel: deps.scopeLabel,
    detail: AUDIT_DETAIL,
  });
  return { link, auditRecorded: await auditPersisted(deps, DELETE_ACTION, resource, startedAt) };
}

export function formatReport(report: LinkReport): string {
  const lines = report.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  return [
    `${report.principalId} -> ${report.canonicalId}`,
    ...lines,
    report.ok ? "result: all checks pass" : "result: REFUSED",
  ].join("\n");
}

export function describeError(error: unknown): string {
  return error instanceof PrincipalLinkError ? `${error.status}: ${error.message}` : errMessage(error);
}
