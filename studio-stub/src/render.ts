// Rendering a Knowledge API answer for a person to read.
//
// The rule this file exists to keep is small and absolute: nothing appears in
// the rendering that did not come from Canon. There is no fallback text that
// resembles an answer, no summarised gist when the citations are thin, and no
// prose at all when the record refused. A Studio app that softened a refusal
// into "I could not find much, but generally…" would be the confident wrong
// answer the whole design is against.

import { Answer, Citation, KnowledgeError, Whoami } from './model.js';

export interface RenderInput {
  appName: string;
  personName: string;
  question: string;
  answer: Answer;
}

function citationLine(citation: Citation, index: number): string {
  return `  ${index + 1}. ${citation.title} — version ${citation.version} (page ${citation.pageId})`;
}

export function renderAnswer(input: RenderInput): string {
  const header = `${input.appName} — answering for ${input.personName}`;
  const asked = `Q: ${input.question}`;

  if (input.answer.refused || !input.answer.answer) {
    const reason = input.answer.reason ? ` (${input.answer.reason})` : '';
    return [
      header,
      asked,
      '',
      `The record does not say${reason}.`,
      '',
      'Nothing was answered from outside the record, and nothing was guessed.',
    ].join('\n');
  }

  // An answer without citations is never returned by Canon; if one ever were,
  // this app would rather say nothing than present unattributed prose.
  if (input.answer.citations.length === 0) {
    return [header, asked, '', 'The record does not say (an answer arrived with no citations, so it was not shown).'].join(
      '\n',
    );
  }

  return [
    header,
    asked,
    '',
    input.answer.answer.trim(),
    '',
    'Sources',
    ...input.answer.citations.map(citationLine),
    '',
    `Answered by ${input.appName} on behalf of ${input.personName}. Every page cited above was read ` +
      'with both identities in force; nothing outside their permissions reached this answer.',
  ].join('\n');
}

/** A refusal, rendered as a refusal — never as an empty answer. */
export function renderRefusal(appName: string, personName: string, question: string, err: KnowledgeError): string {
  const by = err.refusedBy;
  const whose =
    by === 'person'
      ? `${personName} does not have access to the material this needs.`
      : by === 'app'
        ? `${appName} does not have access to the material this needs.`
        : by === 'registry'
          ? `The Veryl Agent Registry does not permit ${appName} here.`
          : 'Canon refused the request.';
  return [
    `${appName} — answering for ${personName}`,
    `Q: ${question}`,
    '',
    `No answer: ${whose}`,
    `Canon said: ${err.code} — ${err.message}`,
  ].join('\n');
}

/** The intersection as it stands, for the demonstration and for support calls. */
export function renderWhoami(who: Whoami): string {
  const lines = [
    `App:    ${who.app.name} (Registry ${who.app.registryRef}, Canon actor ${who.app.actorId})`,
    `Person: ${who.person.name} (${who.person.actorId})`,
    `Registry limits: collections ${who.app.permittedCollections.join(', ') || '(none)'}; ` +
      `actions ${who.app.permittedActions.join(', ') || '(none)'}`,
    '',
    'Effective collections (app role ∩ person role, inside the Registry’s limits):',
  ];
  if (who.collections.length === 0) {
    lines.push('  (none — the intersection is empty, so this app can read nothing for this person)');
  } else {
    for (const c of who.collections) {
      lines.push(`  ${c.name}: app ${c.appRole}, person ${c.personRole} → ${c.role}`);
    }
  }
  lines.push('', `Evaluated at ${who.evaluatedAt}. Nothing above is cached; the next call re-evaluates all three.`);
  return lines.join('\n');
}
