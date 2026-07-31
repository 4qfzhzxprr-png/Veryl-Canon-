// Put a backup back, and prove it went back.
//
//   npm run restore -- --from backups/canon-20260731T0300Z.db --to canon.db
//   npm run restore -- --from backups/canon-20260731T0300Z.db --to canon.db --force
//   npm run restore -- --verify backups/canon-20260731T0300Z.db     # check only, restore nothing
//
// Inside a container:
//
//   docker compose stop canon
//   docker compose run --rm --entrypoint node canon \
//     dist/server/scripts/restore.js --from /data/backups/<file> --to /data/canon.db --force
//   docker compose start canon
//
// STOP THE SERVER FIRST. This script cannot tell whether one is running; what
// it does instead is refuse to overwrite an existing record unless you say
// --force, and when you do, it moves the displaced record aside rather than
// deleting it.
//
// The artefact is verified BEFORE anything is moved — a corrupt backup must
// never be allowed to replace a live record, however bad that record is — and
// the restored file is verified again in place, because "the copy succeeded"
// and "the record is there" are different claims. Verification is: SQLite's own
// integrity check, foreign-key consistency, the schema version against this
// build's, that every core table reads back with its row count, and, where this
// build ships a verifier for it, that the audit hash chain is intact.

import { describeVerification, restoreFrom, verifyDatabase } from '../src/backup.js';

interface Args {
  from: string | null;
  to: string;
  verifyOnly: string | null;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    from: null,
    to: process.env.CANON_DB ?? 'canon.db',
    verifyOnly: null,
    force: false,
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
      case '--from':
        args.from = next();
        break;
      case '--to':
        args.to = next();
        break;
      case '--verify':
        args.verifyOnly = next();
        break;
      case '--force':
        args.force = true;
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

const USAGE = `Restore a Canon record from a backup artefact, verifying both ends.

  --from <path>    the backup artefact to restore
  --to <path>      where the record lives (default: $CANON_DB or ./canon.db)
  --force          replace an existing record (the old one is moved aside,
                   not deleted)
  --verify <path>  verify an artefact and exit; restore nothing

Stop the Canon server before restoring.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.from && !args.verifyOnly)) {
    console.log(USAGE);
    if (!args.help) process.exitCode = 1;
    return;
  }

  if (args.verifyOnly) {
    const report = await verifyDatabase(args.verifyOnly);
    console.log(describeVerification(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const summary = await restoreFrom(args.from!, args.to, { force: args.force });
  console.log(`Restored ${summary.artefact} -> ${summary.target}`);
  console.log('--- the artefact, before anything was moved');
  console.log(describeVerification(summary.before));
  console.log('--- the record, in place');
  console.log(describeVerification(summary.after));
  if (summary.after.auditChain === 'unavailable') {
    console.log(
      'NOTE the audit log reads back, but this build ships no hash-chain verifier, so its\n' +
        '     chain was not checked. See OPERATIONS.md, "The audit log".',
    );
  }
  console.log('\nStart the server, then check GET /ready before letting anyone in.');
}

main().catch((err: unknown) => {
  console.error(`restore failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
