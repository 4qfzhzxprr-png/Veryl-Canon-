import { openDb } from '../src/db.js';
import { verifyAuditChain } from '../src/auditchain.js';

// Verify the audit hash chain from the command line:
//
//     CANON_DB=canon.db npm run verify:audit
//
// The same walk `GET /audit/verify` performs, reachable without a running
// server and without an actor. That is deliberate rather than a gap in the
// permission model: this script reads the database file directly, so anyone who
// can run it already holds the strongest access there is to the record. Asking
// it for a Canon role would be theatre. The HTTP route is the one that needs a
// permission check, and it has one (admin on a collection).
//
// Exit status is the point: 0 for a clean chain, 1 for a break, 2 if the
// database could not be read. That is what makes it usable from cron, from a
// backup verification job, or from the step in a deployment pipeline that
// publishes the head hash to an external anchor.

const dbPath = process.env.CANON_DB ?? process.argv[2] ?? 'canon.db';

function main(): number {
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    console.error(`Could not open the record at ${dbPath}: ${(err as Error).message}`);
    return 2;
  }

  const result = verifyAuditChain(db);
  const lines: string[] = [
    `Veryl Canon — audit chain verification`,
    `  record            ${dbPath}`,
    `  checked at        ${result.checkedAt}`,
    `  format            ${result.format} (${result.algorithm})`,
    `  events in log     ${result.events}`,
    `  chained from      event ${result.chainedFromEventId}`,
    `  unchained before  ${result.unchained}`,
    `  verified          ${result.verified}`,
    `  head              ${result.head ? `event ${result.head.eventId} · ${result.head.hash}` : '(none)'}`,
  ];

  if (result.ok) {
    lines.push('', `  RESULT: intact. No break found${result.partial ? ' in the part that was walked' : ''}.`);
  } else {
    const b = result.firstBreak!;
    lines.push(
      '',
      `  RESULT: BROKEN at event ${b.eventId} (${b.kind})`,
      `    ${b.explanation}`,
      ...(b.expected ? [`    expected ${b.expected}`] : []),
      ...(b.found ? [`    found    ${b.found}`] : []),
    );
  }

  if (result.unchained > 0) {
    lines.push(
      '',
      `  ${result.unchained} event(s) predate the chain and are not covered by it. They were written before`,
      '  hash chaining was added to this record; links computed for them now would be computed from their',
      '  present contents and would prove nothing, so Canon does not compute them.',
    );
  }

  lines.push(
    '',
    '  What a clean result proves:',
    `    ${result.proves}`,
    '',
    '  What it does not:',
    `    ${result.limits}`,
    '',
    '  Recommended: publish the head hash above, with its event id and the time, somewhere Canon cannot',
    '  write. Once an anchor exists, a wholesale recomputation of the chain can no longer hide a deletion.',
  );

  console.log(lines.join('\n'));
  return result.ok ? 0 : 1;
}

process.exitCode = main();
