import { readFileSync } from 'node:fs';
import { compareAttestations, renderComparison } from '../src/attestcompare.js';
import { CanonError } from '../src/model.js';

// Compare an attestation you KEPT against one taken later:
//
//     node dist/server/scripts/compare-attestations.js retained.json fresh.json
//     node dist/server/scripts/compare-attestations.js retained.json fresh.json --json
//
// This is the check that survives an attacker with write access to Canon's
// database, and it is the only one in the product that does.
//
// USER-TESTING.md T3.2: an auditor deleted an audit event, reattributed an
// approval, and recomputed all 1,171 chain links. `GET /audit/verify` answered
// `ok: true`. Every check Canon can make is a check of the record against
// itself, and a wholesale recomputation makes the record agree with itself
// again. What named the forgery was the attestation she had kept from before
// it: event 724 missing, 726's actor changed, four hashes changed. This command
// is that comparison, so that nobody has to write their own hash verifier to
// perform it — though anybody can, and the recipe is in every bundle.
//
// It reads two files and nothing else: no database, no network, no running
// Canon. Run it on a laptop, years later, against a deployment that no longer
// exists. It trusts neither file — each is checked against its own content
// digest and its own chain links first — and when they disagree it reports the
// disagreement rather than deciding which one is honest, because it cannot know
// that and you can: the honest one is the copy you have had in your custody
// since the day it was generated.
//
// Exit status: 0 when nothing impossible was found, 1 when it was, 2 when a
// file could not be read or is not an attestation bundle. `--json` prints the
// whole comparison as JSON instead of prose, for a pipeline that files the
// result rather than reading it.

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CanonError('invalid', `Could not read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CanonError(
      'invalid',
      `${path} is not valid JSON: ${(err as Error).message}. This tool compares the JSON form of a bundle; the ` +
        'HTML rendering is for reading, not for comparing. Ask Canon for the same attestation without ' +
        '`?format=html` and keep both.',
    );
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const paths = argv.filter((a) => !a.startsWith('-'));
  const [retained, later] = paths;
  if (!retained || !later) {
    console.error(
      [
        'Usage: compare-attestations <retained.json> <later.json> [--json]',
        '',
        '  <retained.json>  the attestation you kept, from your own custody',
        '  <later.json>     one generated now, for the same page or collection',
        '',
        'Ask Canon for the later one with:',
        '  GET /pages/<id>/attestation              (add ?at=… to match the retained copy)',
        '  GET /collections/<id>/attestation?at=…   (the same instant, or the registers are two questions)',
      ].join('\n'),
    );
    return 2;
  }

  let result;
  try {
    result = compareAttestations(readJson(retained), readJson(later), [retained, later]);
  } catch (err) {
    console.error(err instanceof CanonError ? err.message : `Could not compare these files: ${(err as Error).message}`);
    return 2;
  }

  process.stdout.write(asJson ? JSON.stringify(result, null, 2) + '\n' : renderComparison(result));
  return result.ok ? 0 : 1;
}

process.exitCode = main();
