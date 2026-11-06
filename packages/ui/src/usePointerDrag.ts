import { useRef, useState, type PointerEvent } from 'react';

export interface DragPoint {
  x: number;
  y: number;
}

// Pointer capture keeps internal drags in the webview, without Windows OLE
// taking over the gesture. A short press remains a normal button click.
export default function usePointerDrag<T>(onDrop: (value: T, point: DragPoint) => void) {
  const gesture = useRef<{ id: number; value: T; start: DragPoint; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ value: T; point: DragPoint } | null>(null);
  const cancel = () => {
    gesture.current = null;
    setPreview(null);
  };
  return {
    preview,
    start: (event: PointerEvent<HTMLElement>, value: T) => {
      if (event.button !== 0 || event.isPrimary === false || gesture.current) return;
      suppressClick.current = false;
      gesture.current = {
        id: event.pointerId,
        value,
        start: { x: event.clientX, y: event.clientY },
        active: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    move: (event: PointerEvent<HTMLElement>) => {
      const drag = gesture.current;
      if (!drag || drag.id !== event.pointerId) return;
      const point = { x: event.clientX, y: event.clientY };
      if (!drag.active && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 6) return;
      drag.active = true;
      event.preventDefault();
      setPreview({ value: drag.value, point });
    },
    end: (event: PointerEvent<HTMLElement>) => {
      const drag = gesture.current;
      if (!drag || drag.id !== event.pointerId) return;
      cancel();
      if (drag.active) {
        suppressClick.current = true;
        event.preventDefault();
        onDrop(drag.value, { x: event.clientX, y: event.clientY });
      }
    },
    cancel: (event: PointerEvent<HTMLElement>) => {
      if (gesture.current?.id !== event.pointerId) return;
      suppressClick.current = gesture.current.active;
      cancel();
    },
    consumeClick: () => {
      const consumed = suppressClick.current;
      suppressClick.current = false;
      return consumed;
    },
  };
}
