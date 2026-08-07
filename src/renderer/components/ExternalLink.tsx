// Web link component that prefers Chat's embedded browser and falls back to
// the system handler outside Chat or on explicit Cmd/Ctrl click.

import { type ReactNode, type MouseEvent } from 'react';
import { useOpenWebLink } from '@/context/BrowserPanelContext';

interface ExternalLinkProps {
    href: string;
    children: ReactNode;
    className?: string;
    title?: string;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * A web link that uses the active product preview surface while still allowing
 * text selection for copying.
 *
 * Click behavior:
 * - Single click without text selection: opens the link
 * - Click after selecting text: does not open (allows copy)
 */
export function ExternalLink({ href, children, className, title, onClick }: ExternalLinkProps) {
    const openWebLink = useOpenWebLink();
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        onClick?.(e);

        // Check if user is selecting text (has selection)
        const selection = window.getSelection();
        const hasSelection = selection && selection.toString().length > 0;

        if (!hasSelection && href) {
            openWebLink(href, { forceExternal: e.metaKey || e.ctrlKey });
        }
    };

    return (
        <a
            href={href}
            onClick={handleClick}
            className={className}
            title={title}
            // Allow text selection
            style={{ userSelect: 'text' }}
        >
            {children}
        </a>
    );
}

export default ExternalLink;
