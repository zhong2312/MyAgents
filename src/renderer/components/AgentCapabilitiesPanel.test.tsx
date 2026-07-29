import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AgentCapabilitiesPanel from './AgentCapabilitiesPanel';
import { ToastProvider } from './Toast';

// Regression for #314: the tree↔capabilities visual boundary is owned by the
// parent (DirectoryPanel's drag-divider). When the capability list is empty,
// the empty-state branch used to render its OWN top border `mx-4 border-b`
// directly below the parent's separator — producing two divider lines.
// Neither render branch should emit its own border line; the parent draws the
// only separator. This test pins both branches.
describe('AgentCapabilitiesPanel — divider ownership (#314)', () => {
    function renderPanel(props: React.ComponentProps<typeof AgentCapabilitiesPanel>) {
        return render(
            <ToastProvider>
                <AgentCapabilitiesPanel {...props} />
            </ToastProvider>,
        );
    }

    it('empty state does not render its own border line (parent owns the separator)', () => {
        const { container } = renderPanel({
            enabledAgents: {},
            enabledSkills: [],
            enabledCommands: [],
        });
        const panel = container.querySelector('[data-capabilities-panel]');
        expect(panel).not.toBeNull();
        // The capabilities panel itself must contribute zero `border-b` / `border-t`
        // elements — otherwise it stacks on the parent's drag-divider.
        const borderEls = panel!.querySelectorAll('.border-b, .border-t');
        expect(borderEls.length).toBe(0);
    });

    it('non-empty state — every section (commands + skills + agents) is border-free', () => {
        // Render at least one item in each section so the test exercises every
        // rendered subtree, not just the commands path.
        const { container } = renderPanel({
            enabledAgents: { planner: { description: 'planning agent', scope: 'user' } },
            enabledSkills: [{ name: 'docx', description: 'word docs', scope: 'user' }],
            enabledCommands: [{ name: 'help', description: 'show help', scope: 'user' }],
        });
        const panel = container.querySelector('[data-capabilities-panel]');
        expect(panel).not.toBeNull();
        const borderEls = panel!.querySelectorAll('.border-b, .border-t');
        expect(borderEls.length).toBe(0);
    });

    it('starts collapsed and reveals capabilities only after an explicit toggle', () => {
        renderPanel({
            enabledAgents: { planner: { description: 'planning agent', scope: 'user' } },
            enabledSkills: [{ name: 'docx', description: 'word docs', scope: 'user' }],
            enabledCommands: [{ name: 'help', description: 'show help', scope: 'user' }],
        });

        const toggle = screen.getByRole('button', { expanded: false });
        expect(screen.queryByText('docx')).not.toBeInTheDocument();

        fireEvent.click(toggle);

        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('docx')).toBeInTheDocument();
    });
});
