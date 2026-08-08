/**
 * A card's own short vocabulary note.
 *
 * The writing rule says to define a technical term the first time it is used. Five card files each
 * defining "finding" inline would be five chances to define it differently, so each card declares
 * its terms once and this renders them.
 */
export interface GlossaryTerm {
  /** The word as it appears in the card's prose. */
  term: string;
  /** What it means, in words that need no further explanation. */
  plain: string;
}

/** The sentence a glossary renders, or null when a card declares no terms. Split out from the
 *  component so the wording can be tested without rendering a component tree. */
export function glossaryText(terms: readonly GlossaryTerm[]): string | null {
  if (terms.length === 0) return null;
  const parts = terms.map((t) => `${t.term} means ${t.plain}`);
  const joined =
    parts.length === 1 ? parts[0]!
    : parts.length === 2 ? `${parts[0]}, and ${parts[1]}`
    : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  return `In this card, ${joined}.`;
}

export function CardGlossary({ terms }: { terms: readonly GlossaryTerm[] }) {
  const text = glossaryText(terms);
  if (text === null) return null;
  return <p class="card-glossary">{text}</p>;
}
