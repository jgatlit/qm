import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { loadConfig } from "../src/config.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPrincipalLinkService, type PrincipalLink } from "../src/identity/principal-links.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { configurePgCaTrust } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import {
  applyLink,
  applyUnlink,
  checkLink,
  describeError,
  formatReport,
  previewUnlink,
  type LinkOpsDeps,
} from "./lib/principal-link-ops.ts";

const USAGE = `usage:
  principal-link.ts list
  principal-link.ts check <principal> <canonical>
  principal-link.ts link <principal> <canonical> --evidence <text> --by <adminId> [--apply]
  principal-link.ts unlink <principal> [--by <adminId>] [--apply]
dry-run unless --apply is given`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--apply") continue;
    if (a.startsWith("--")) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printLink(l: PrincipalLink): string {
  return `${l.principalId} -> ${l.canonicalId}  linkedBy=${l.linkedBy}  createdAt=${new Date(l.createdAt).toISOString()}\n    evidence: ${l.evidence}`;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || !["list", "check", "link", "unlink"].includes(command)) fail(USAGE);
const apply = rest.includes("--apply");
const pos = positionals(rest);

const config = loadConfig();
if (!config.databaseUrl) fail("DATABASE_URL is not configured; refusing to run against a memory store");
configurePgCaTrust({
  ...(config.databaseCaCert ? { cert: config.databaseCaCert } : {}),
  ...(config.databaseCaCertFile ? { certFile: config.databaseCaCertFile } : {}),
});

const maps = createPostgresMapFactory(config.databaseUrl);
const directory = createPostgresDirectoryStore(config.databaseUrl);
const grantStore = createPostgresAdminGrantStore(config.databaseUrl);
const deps: LinkOpsDeps = {
  links: createPrincipalLinkService(maps.map<PrincipalLink>("principal_links"), createPostgresAdvisoryLock(maps.pool)),
  directory,
  grants: grantStore,
  audit: createPostgresAuditLog(config.databaseUrl),
  scopeLabel: scopeId("org", config.orgId),
};

let exitCode = 0;
try {
  if ((await deps.grants.all()).length === 0)
    fail("no admin grants found in the database; refusing to evaluate admin checks");
  if (command === "list") {
    const links = await deps.links.list();
    console.log(links.length ? links.map(printLink).join("\n") : "no principal links");
  } else if (command === "check") {
    const [principal, canonical] = pos;
    if (!principal || !canonical) fail(USAGE);
    const report = await checkLink(deps, { principalId: principal, canonicalId: canonical });
    console.log(formatReport(report));
    if (!report.ok) exitCode = 2;
  } else if (command === "link") {
    const [principal, canonical] = pos;
    const evidence = flag(rest, "--evidence");
    const by = flag(rest, "--by");
    if (!principal || !canonical || !evidence || !by) fail(USAGE);
    const request = { principalId: principal, canonicalId: canonical, evidence, by };
    const report = await checkLink(deps, request);
    console.log(formatReport(report));
    if (!report.ok) exitCode = 2;
    else if (!apply) console.log("dry-run: nothing written; re-run with --apply to create the link");
    else {
      const result = await applyLink(deps, request);
      console.log(`${result.created ? "linked" : "already linked"}: ${printLink(result.link)}`);
      if (result.created)
        console.log(`audit ${result.auditRecorded ? "recorded" : "NOT FOUND"}: principal_link.create`);
      if (result.created && !result.auditRecorded) exitCode = 3;
    }
  } else {
    const [principal] = pos;
    if (!principal) fail(USAGE);
    const by = flag(rest, "--by");
    const existing = await previewUnlink(deps, principal);
    if (!existing) console.log(`${principal} has no link; nothing to do`);
    else if (!apply) console.log(`dry-run: would remove ${printLink(existing)}\nre-run with --apply to remove it`);
    else {
      const result = await applyUnlink(deps, principal, by);
      console.log(result.link ? `unlinked: ${printLink(result.link)}` : "link already gone");
      if (result.link) console.log(`audit ${result.auditRecorded ? "recorded" : "NOT FOUND"}: principal_link.delete`);
      if (result.link && !result.auditRecorded) exitCode = 3;
    }
  }
} catch (error) {
  console.error(`error: ${describeError(error)}`);
  exitCode = 1;
} finally {
  await maps.pool.close();
}
process.exit(exitCode);
