// Take a verified backup of the record.
//
//   npm run backup                                  # ./canon.db -> ./backups/canon-<timestamp>.db
//   npm run backup -- --db /data/canon.db --out /data/backups
//   npm run backup -- --out /data/backups/nightly.db --force
//   npm run backup -- --keep 14                     # prune artefacts older than the newest 14
//
// Inside a container the build step is not present, so call the compiled
// script directly:
//
//   docker compose exec canon node dist/server/scripts/backup.js --out /data/backups
//
// Safe to run against a server that is serving. The snapshot is `VACUUM INTO`,
// which takes a read transaction: writers keep writing, and the artefact holds
// every transaction committed before it started. Never `cp canon.db` — under
// WAL that copies a file whose newest commits are in a WAL it did not copy, and
// the result looks perfectly healthy while missing the end of the audit log.
//
// Every artefact is verified before this script calls it a backup, and a
// snapshot that fails verification is deleted rather than left to be trusted.
// Exit code 0 means there is a verified backup at the path printed; anything
// else means there is not.

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backupTo, describeVerification } from '../src/backup.js';
import { openDb } from '../src/db.js';

interface Args {
  db: string;
  out: string;
  force: boolean;
  keep: number;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: process.env.CANON_DB ?? 'canon.db',
    out: 'backups',
    force: false,
    keep: 0,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--db':
        args.db = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--keep':
        args.keep = Number(next());
        break;
      case '--force':
        args.force = true;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `Take a verified backup of the Canon record.

  --db <path>    the live record (default: $CANON_DB or ./canon.db)
  --out <path>   a directory to write a timestamped artefact into, or a file
                 name to write exactly (default: ./backups)
  --keep <n>     after a successful backup, delete all but the newest n
                 artefacts in the output directory (default: keep everything)
  --force        overwrite an artefact that is already there
  --quiet        print only the artefact path
`;

function timestamped(directory: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  return join(directory, `canon-${stamp}.db`);
}

/**
 * Retention, applied only after a backup has verified. Never prunes on a failed
 * run: the moment backups start failing is precisely the moment the old ones
 * become the only copy there is.
 */
function prune(directory: string, keep: number, quiet: boolean): void {
  if (keep <= 0) return;
  const artefacts = readdirSync(directory)
    .filter((name) => /^canon-.*\.db$/.test(name))
    .map((name) => ({ name, path: join(directory, name), mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of artefacts.slice(keep)) {
    unlinkSync(stale.path);
    if (!quiet) console.log(`pruned ${stale.path}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!existsSync(args.db)) {
    throw new Error(`No record at ${resolve(args.db)} (set --db or CANON_DB)`);
  }

  const outIsDirectory = existsSync(args.out) ? statSync(args.out).isDirectory() : !args.out.endsWith('.db');
  const artefactPath = outIsDirectory ? timestamped(args.out) : args.out;

  // Opening the record runs migrations, which is deliberate: a backup of a
  // database this build cannot open is not a backup this build can restore, and
  // discovering that at restore time is discovering it too late.
  const db = openDb(args.db);
  try {
    const summary = await backupTo(db, artefactPath, { force: args.force });
    if (args.quiet) {
      console.log(summary.artefact);
      return;
    }
    console.log(`Backed up ${summary.source} -> ${summary.artefact}`);
    console.log(`${summary.bytes} bytes in ${summary.durationMs}ms, started ${summary.startedAt}`);
    console.log(describeVerification(summary.verification));
    if (summary.verification.auditChain === 'unavailable') {
      console.log(
        'NOTE the audit log was copied and read back, but this build ships no hash-chain\n' +
          '     verifier, so its chain was not checked. See OPERATIONS.md, "The audit log".',
      );
    }
  } finally {
    db.close();
  }
  if (outIsDirectory) prune(args.out, args.keep, args.quiet);
}

main().catch((err: unknown) => {
  console.error(`backup failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
