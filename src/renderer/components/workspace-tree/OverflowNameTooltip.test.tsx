import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverflowNameTooltip } from "./OverflowNameTooltip";

function setMeasuredWidth(
  element: HTMLElement,
  widths: { clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: widths.clientWidth,
  });
  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    value: widths.scrollWidth,
  });
}

describe("OverflowNameTooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the full name immediately when the visible text is truncated", async () => {
    const label = "2026.7.7-super-long-research-document-version-final.md";
    render(<OverflowNameTooltip label={label} className="block truncate" />);

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 360 });
    fireEvent.pointerEnter(trigger);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
  });

  it("does not show a tooltip for names that already fit", () => {
    const label = "README.md";
    render(<OverflowNameTooltip label={label} className="block truncate" />);

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 160, scrollWidth: 80 });
    fireEvent.pointerEnter(trigger);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("waits for the configured hover delay and cancels when the pointer leaves", () => {
    vi.useFakeTimers();
    const label = "A long historical conversation title...";
    const tooltipLabel =
      "A long historical conversation title that is visibly truncated";
    render(
      <OverflowNameTooltip
        label={label}
        tooltipLabel={tooltipLabel}
        className="block truncate"
        delayMs={1_000}
      />,
    );

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 360 });
    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("tooltip")).toHaveTextContent(tooltipLabel);
  });

  it("rechecks overflow when the hover delay elapses", () => {
    vi.useFakeTimers();
    const label = "A title that initially overflows";
    render(
      <OverflowNameTooltip
        label={label}
        className="block truncate"
        delayMs={1_000}
      />,
    );

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 240 });
    fireEvent.pointerEnter(trigger);
    setMeasuredWidth(trigger, { clientWidth: 260, scrollWidth: 240 });
    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes an open tooltip when the title grows wide enough to fit", () => {
    vi.useFakeTimers();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    const label = "A title whose available width can change";
    render(
      <OverflowNameTooltip
        label={label}
        className="block truncate"
        delayMs={1_000}
      />,
    );

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 240 });
    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    setMeasuredWidth(trigger, { clientWidth: 260, scrollWidth: 240 });
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
      }
    });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });

  it("cancels delayed opening on pointer down, label change, and unmount", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const view = render(
      <OverflowNameTooltip
        label="First overflowing title"
        className="block truncate"
        delayMs={1_000}
      />,
    );

    let trigger = screen.getByText("First overflowing title");
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 240 });
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerDown(trigger);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    view.rerender(
      <OverflowNameTooltip
        label="Second overflowing title"
        className="block truncate"
        delayMs={1_000}
      />,
    );
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    trigger = screen.getByText("Second overflowing title");
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 240 });
    fireEvent.pointerEnter(trigger);
    view.unmount();
    act(() => vi.advanceTimersByTime(1_000));
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
