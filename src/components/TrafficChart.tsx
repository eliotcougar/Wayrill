import { memo, useEffect, useRef, useState } from 'react';
import type { RateUnit } from '../trafficUnits';
import type { TrafficPoint } from '../traffic';
import { trafficRatePath, trafficScale } from '../trafficPresentation';

export default memo(function TrafficChart({
  points,
  minutes,
  unit,
}: {
  points: TrafficPoint[];
  minutes: number;
  unit?: RateUnit;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 220 });
  useEffect(() => {
    if (!svg.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  const left = 64,
    right = size.width - 14,
    top = 12,
    bottom = size.height - 30;
  const end = points.at(-1)?.elapsedMs ?? 0,
    span = minutes * 60000,
    start = end - span;
  const scale = trafficScale(points, unit);
  const x = (elapsedMs: number) => left + ((elapsedMs - start) / span) * (right - left);
  const y = (rate: number) => bottom - (rate / scale.top) * (bottom - top);
  const upload = trafficRatePath(points, 'uploadPerSecond', start, x, y);
  const download = trafficRatePath(points, 'downloadPerSecond', start, x, y);
  return (
    <figure className="traffic-chart">
      <figcaption>
        <span className="traffic-up-line" aria-hidden="true" />
        Upload <span className="traffic-down-line" aria-hidden="true" />
        Download
        <span
          className="traffic-chart-caption"
          title={`Automatic scale based on retained history. Last ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}; gaps indicate missing samples.`}
        >
          0–{scale.label(scale.top)} {scale.unit}
        </span>
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label="Upload and download rate history"
      >
        <title>Traffic rates over time</title>
        <desc>
          Steps show the average rate for each measured interval. Upload uses a dashed line;
          download uses a solid line. Both share the same vertical scale in {scale.unit}. Gaps are
          missing measurements. Current rates and totals appear above; missing measurements are
          shown with an em dash.
        </desc>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={left}
              x2={right}
              y1={y(scale.top * f)}
              y2={y(scale.top * f)}
              className="traffic-grid"
            />
            <text x={left - 10} y={y(scale.top * f) + 4} textAnchor="end">
              {scale.label(scale.top * f)}
            </text>
          </g>
        ))}
        {(
          [
            ['traffic-up', upload],
            ['traffic-down', download],
          ] as const
        ).map(
          ([className, path]) =>
            path && (
              <path
                key={className}
                className={className}
                d={path}
                fill="none"
                strokeWidth="2.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ),
        )}
        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={left + (right - left) * f}
            y={size.height - 8}
            textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
          >
            {f === 1 ? 'Latest sample' : `${Math.round((span * (1 - f)) / 1000)} s ago`}
          </text>
        ))}
        {!upload && !download && (
          <text
            x={(left + right) / 2}
            y={(top + bottom) / 2}
            textAnchor="middle"
            className="traffic-chart-empty"
          >
            No measured rates in this window
          </text>
        )}
      </svg>
    </figure>
  );
});
