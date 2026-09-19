import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const WIDTH = 280;
const GAP = 8;

/**
 * A hover/focus tooltip rendered through a portal to `document.body`.
 *
 * Every list in this app that needs one (`.picker` in App.tsx, the blessing
 * board) lives inside a scrolling or otherwise clipped container, so a plain
 * CSS `position: absolute` bubble would get cut off by its ancestor's
 * `overflow`. Rendering to `document.body` with `position: fixed`, positioned
 * from the trigger's own `getBoundingClientRect()`, sidesteps that entirely.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const show = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  const hide = () => setRect(null);

  if (!content) return <>{children}</>;

  return (
    <span ref={ref} className="tooltip-anchor" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {rect &&
        createPortal(
          <div className="tooltip-bubble" role="tooltip" style={placement(rect)}>
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

function placement(rect: DOMRect): React.CSSProperties {
  const left = Math.min(Math.max(rect.left, GAP), window.innerWidth - WIDTH - GAP);
  // Open downward near the top of the viewport, upward everywhere else.
  return rect.top > 160
    ? { left, top: rect.top - GAP, transform: 'translateY(-100%)' }
    : { left, top: rect.bottom + GAP };
}
