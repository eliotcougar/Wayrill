import { createContext, memo, useContext } from 'react';
import { BaseEdge, EdgeText, type EdgeProps } from '@xyflow/react';
import type { EdgePath } from '../graph/edgePaths';
import { connectionTypes } from '../graph/connectionKinds';

export const EdgeRoutesContext = createContext<ReadonlyMap<string, EdgePath>>(new Map());

function SchematicEdge(props: EdgeProps) {
  const route = useContext(EdgeRoutesContext).get(props.id);
  // Measurements may not be ready during the initial layout. Do not briefly
  // draw a different, obstacle-blind route underneath the real schematic.
  if (!route || route.blocked) return null;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={route.path}
        labelX={route.labelX}
        labelY={route.labelY}
        style={props.style}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        interactionWidth={12}
      />
      {route.sharedWires.map((wire, index) => (
        <g key={index} className="edge-bundle" pointerEvents="none">
          <title>
            Combined {wire.kinds.map((kind) => connectionTypes[kind].label).join(' / ')} input
          </title>
          {wire.kinds.map((kind, i) => (
            <path
              key={kind}
              d={wire.path}
              fill="none"
              stroke={connectionTypes[kind].color}
              strokeWidth={props.style?.strokeWidth ?? 1.8}
              strokeDasharray={`6 ${6 * (wire.kinds.length - 1)}`}
              strokeDashoffset={-6 * i}
            />
          ))}
        </g>
      ))}
      {route.junctions.map((p) => (
        <circle
          key={`${p.x}:${p.y}`}
          cx={p.x}
          cy={p.y}
          r={3.5}
          fill={props.style?.stroke ?? 'currentColor'}
          className="edge-junction"
          pointerEvents="none"
        >
          <title>Connections merge into the same input</title>
        </circle>
      ))}
      <EdgeText
        x={route.labelX}
        y={route.labelY}
        label={props.label}
        labelStyle={props.labelStyle}
        labelShowBg={props.labelShowBg}
        labelBgStyle={props.labelBgStyle}
        labelBgPadding={props.labelBgPadding}
        labelBgBorderRadius={props.labelBgBorderRadius}
      />
    </>
  );
}

export default memo(SchematicEdge);
