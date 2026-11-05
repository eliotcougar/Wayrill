import { memo } from 'react';
import type { EdgeProps } from '@xyflow/react';
import SharedSchematicEdge from '@wayrill/ui/schematic/SchematicEdge';
import type { EdgePath } from '@wayrill/ui/schematic/edgePaths';
import { EdgeActivity } from './GraphActivity';

export { EdgeRoutesContext } from '@wayrill/ui/schematic/SchematicEdge';

const renderActivity = (route: EdgePath, props: EdgeProps) => (
  <EdgeActivity id={props.id} path={route.path} color={props.style?.stroke} />
);
function SchematicEdge(props: EdgeProps) {
  return <SharedSchematicEdge {...props} renderActivity={renderActivity} />;
}
export default memo(SchematicEdge);
