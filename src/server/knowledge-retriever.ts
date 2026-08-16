export interface KnowledgeRetrieverDocument {
  readonly path: string;
  readonly content: string;
}

export interface KnowledgeRetrieverHit {
  readonly id: string;
  readonly path: string;
  readonly score: number;
  readonly snippet: string;
  readonly citations: readonly { readonly path: string; readonly line: number }[];
  readonly retrieval: {
    readonly lexicalScore: number;
    readonly semanticScore: number;
    readonly rerankScore: number;
  };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("zh-CN").trim();
}

function queryTerms(query: string): readonly string[] {
  const normalized = normalize(query);
  const words = normalized.split(/\s+/u).filter(Boolean);
  const compact = normalized.replace(/\s+/gu, "");
  const bigrams = compact.length > 1
    ? Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2))
    : [compact];
  return [...new Set([...words, ...bigrams].filter(Boolean))];
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function snippetAt(document: KnowledgeRetrieverDocument, term: string) {
  const normalized = normalize(document.content);
  const index = Math.max(0, normalized.indexOf(term));
  const line = lineAt(document.content, index);
  return {
    line,
    snippet: document.content
      .slice(Math.max(0, index - 160), Math.min(document.content.length, index + 360))
      .replace(/\s+/gu, " ")
      .trim(),
  };
}

/**
 * Embedding-free hybrid retriever used by the built-in Agent tool. Lexical
 * coverage keeps exact facts reliable, character n-gram overlap handles
 * natural Chinese queries, and the final score is a deterministic rerank.
 */
export function retrieveKnowledgeDocuments(
  documents: readonly KnowledgeRetrieverDocument[],
  query: string,
  limit: number,
): readonly KnowledgeRetrieverHit[] {
  const normalizedQuery = normalize(query);
  const terms = queryTerms(query);
  return documents
    .map((document): KnowledgeRetrieverHit | null => {
      const normalized = normalize(document.content);
      const path = normalize(document.path);
      const phrase = normalized.includes(normalizedQuery);
      const matchedTerms = terms.filter((term) => normalized.includes(term));
      const wordTerms = terms.filter((term) => term.length > 2);
      const coverage = terms.length ? matchedTerms.length / terms.length : 0;
      const semanticCoverage = wordTerms.length
        ? wordTerms.filter((term) => normalized.includes(term)).length / wordTerms.length
        : coverage;
      const lexicalScore =
        (phrase ? 60 : 0) +
        matchedTerms.length * 8 +
        (path.includes(normalizedQuery) ? 24 : 0);
      const semanticScore = Math.round(semanticCoverage * 40);
      const rerankScore = Math.round(lexicalScore * 0.7 + semanticScore * 0.3);
      if (rerankScore <= 0) return null;
      const firstTerm = matchedTerms[0] ?? normalizedQuery;
      const location = snippetAt(document, firstTerm);
      return {
        id: `knowledge:${document.path}:${location.line}`,
        path: document.path,
        score: rerankScore,
        snippet: location.snippet,
        citations: [{ path: document.path, line: location.line }],
        retrieval: { lexicalScore, semanticScore, rerankScore },
      };
    })
    .filter((hit): hit is KnowledgeRetrieverHit => hit !== null)
    .sort(
      (left, right) =>
        right.retrieval.rerankScore - left.retrieval.rerankScore ||
        left.path.localeCompare(right.path),
    )
    .slice(0, Math.max(1, limit));
}
