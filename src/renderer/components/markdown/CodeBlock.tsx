/**
 * CodeBlock - Syntax highlighted code block with copy button
 * Supports all major programming languages via react-syntax-highlighter
 */

import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useResolvedTheme } from '@/theme';
import { copyPlainText } from '@/utils/clipboard';

interface CodeBlockProps {
    children: string;
    language?: string;
    className?: string;
}


export default function CodeBlock({ children, language, className }: CodeBlockProps) {
    const { t } = useTranslation('app');
    const customTheme = useResolvedTheme().adapters.prism;
    const [copied, setCopied] = useState(false);

    // Extract language from className if not provided directly
    const extractedLanguage = language || className?.replace(/language-/, '') || 'text';

    const handleCopy = useCallback(async () => {
        try {
            await copyPlainText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [children]);

    return (
        <div className="markdown-code-block group relative w-full overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/30">
            {/* Header with language label and copy button */}
            <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--code-bg)] px-4 py-2 text-xs">
                <span className="font-mono text-[var(--code-line-number)] uppercase tracking-wide">
                    {extractedLanguage}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-[var(--code-line-number)] transition-colors hover:bg-[var(--line-subtle)] hover:text-[var(--code-text)]"
                    title={copied ? t('markdown.copied') : t('markdown.copyCode')}
                >
                    {copied ? (
                        <>
                            <Check className="size-3.5" />
                            <span>{t('markdown.copied')}</span>
                        </>
                    ) : (
                        <>
                            <Copy className="size-3.5" />
                            <span>{t('markdown.copy')}</span>
                        </>
                    )}
                </button>
            </div>

            {/* Code content with syntax highlighting */}
            <SyntaxHighlighter
                language={extractedLanguage}
                style={customTheme}
                className="overflow-x-auto"
                customStyle={{
                    margin: 0,
                    background: 'transparent',
                    borderTopLeftRadius: 0,
                    borderTopRightRadius: 0,
                }}
                showLineNumbers={children.split('\n').length > 5}
                lineNumberStyle={{
                    minWidth: '2.5em',
                    paddingRight: '1em',
                    color: 'var(--code-line-number)',
                    userSelect: 'none',
                }}
                wrapLongLines={false}
            >
                {children.trim()}
            </SyntaxHighlighter>
        </div>
    );
}
