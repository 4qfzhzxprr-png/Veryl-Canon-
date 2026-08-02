import { openDb } from '../src/db.js';
import { anchorLine, appendAnchor, ANCHOR_LIMITS, ANCHOR_PROVES, headAnchor } from '../src/headanchor.js';

// Take one audit-chain head anchor, from the command line:
//
//     node dist/server/scripts/anchor-head.js --db /data/canon.db >> anchors.ndjson
//     node dist/server/scripts/anchor-head.js --db /data/canon.db --append /var/anchors.ndjson
//     node dist/server/scripts/anchor-head.js --db /data/canon.db --explain
//
// One JSON object on stdout, one line, nothing else — so the useful form of
// this command is the one with a `>>` in it, and the useful place for the `>>`
// is a path on another machine.
//
// WHY A SCRIPT AS WELL AS THE TIMER. The server takes an anchor every hour into
// its log (headanchor.ts). That covers the deployment that ships its logs. It
// does not cover the deployment whose evidence process is a scheduled job — the
// one that already runs `verify-audit`, already takes the nightly backup, and
// wants the head hash recorded in the same place and at the same moment as the
// backup it belongs to. This is that command. It opens the record read-only in
// every sense that matters: it writes nothing to the database, appends no audit
// event, and changes no state, so it is safe to run against a live record and
// safe to run as often as you like.
//
// WHAT AN ANCHOR IS WORTH, said here as well as in headanchor.ts because this
// is where an operator meets it: NOTHING, until a copy of the line is held
// somewhere Canon cannot write. Redirecting it into a file on the Canon server
// and stopping there buys a file an attacker rewrites in the same afternoon
// they rewrite the chain. The value is entirely in the copy that leaves.
//
// Exit status: 0 when an anchor was taken, 2 when the record could not be read,
// 3 when a `--append` file could not be written (the line is still on stdout, so
// a pipeline can recover).

interface Args {
  db: string;
  append: string | null;
  explain: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: process.env.CANON_DB ?? 'canon.db', append: null, explain: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--db' || flag === '-d') && value) {
      args.db = value;
      i += 1;
    } else if (flag === '--append' && value) {
      args.append = value;
      i += 1;
    } else if (flag === '--explain') {
      args.explain = true;
    } else if (flag && !flag.startsWith('-') && args.db === (process.env.CANON_DB ?? 'canon.db')) {
      // A bare path, the way verify-audit.js takes one.
      args.db = flag;
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  let db;
  try {
    db = openDb(args.db);
  } catch (err) {
    console.error(`Could not open the record at ${args.db}: ${(err as Error).message}`);
    return 2;
  }

  const record = headAnchor(db);
  process.stdout.write(anchorLine(record));

  let status = 0;
  if (args.append) {
    try {
      appendAnchor(args.append, record);
    } catch (err) {
      console.error(`The anchor was taken but could not be appended to ${args.append}: ${(err as Error).message}`);
      status = 3;
    }
  }

  if (args.explain) {
    console.error(
      [
        '',
        'Veryl Canon — audit chain head anchor',
        `  record          ${args.db}`,
        `  taken at        ${record.takenAt}`,
        `  head event      ${record.headEventId ?? '(no chained events yet)'}`,
        `  head hash       ${record.headHash ?? '—'}`,
        `  events in log   ${record.events}`,
        `  chain started   ${record.chainStartedAt ?? '(no chain metadata)'}`,
        '',
        '  What a retained anchor proves:',
        `    ${ANCHOR_PROVES}`,
        '',
        '  What it does not:',
        `    ${ANCHOR_LIMITS}`,
        '',
        '  This line is only evidence once a copy of it is somewhere Canon cannot write. Send it to your',
        '  log store, your compliance mailbox, or an object store with retention locked on — and keep the',
        '  series, not just the latest one. OPERATIONS.md, "Anchor the chain head".',
        '',
      ].join('\n'),
    );
  }

  return status;
}

process.exitCode = main();
