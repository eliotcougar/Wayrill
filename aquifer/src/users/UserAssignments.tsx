import { Plus, Unlink, Users } from 'lucide-react';
import {
  inboundObjects,
  inboundUserProtocol,
  userProtocols,
  scalarText,
  type UserSet,
  type UserWorkspace,
} from './model';

export function InboundUserAssignments({
  index,
  workspace,
  onEdit,
  onChoose,
  onDisconnect,
}: {
  index: number;
  workspace: UserWorkspace;
  onEdit: (set: UserSet) => void;
  onChoose: () => void;
  onDisconnect: (setId: string, inbound: number) => void;
}) {
  const bindings = workspace.bindings.filter((b) => b.inbound === index);
  return (
    <section className="user-assignment-panel">
      <div className="user-assignment-heading">
        <h3>
          <Users size={16} />
          User sets
        </h3>
        <button className="secondary-button" onClick={onChoose}>
          <Plus size={15} />
          Assign set
        </button>
      </div>
      <div className="assigned-set-list">
        {bindings.map((b) => {
          const set = workspace.sets.find((s) => s.id === b.set);
          return (
            set && (
              <div key={b.set}>
                <button className="secondary-button assigned-set" onClick={() => onEdit(set)}>
                  <strong>{set.name}</strong>
                  <span>{set.users.filter((u) => u.enabled).length} enabled users</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Disconnect ${set.name}`}
                  title="Disconnect set"
                  onClick={() => onDisconnect(b.set, index)}
                >
                  <Unlink size={15} />
                </button>
              </div>
            )
          );
        })}
      </div>
      {!bindings.length && <p className="muted">No user sets connected.</p>}
    </section>
  );
}
export function UserSetDetails({
  set,
  config,
  workspace,
  onEdit,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  set: UserSet;
  config: Record<string, unknown>;
  workspace: UserWorkspace;
  onEdit: () => void;
  onConnect: (setId: string, inbound: number) => void;
  onDisconnect: (setId: string, inbound: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="user-set-details">
      <div className="user-assignment-heading">
        <h3>{userProtocols[set.protocol]}</h3>
        <button className="secondary-button" onClick={onEdit}>
          Edit users
        </button>
      </div>
      <p className="muted">
        {set.users.filter((u) => u.enabled).length} enabled · {set.users.length} total
      </p>
      <h3>Connected inbounds</h3>
      <div className="user-target-list">
        {inboundObjects(config).map(
          (inbound, index) =>
            inboundUserProtocol(inbound) === set.protocol && (
              <label className="check-control" key={index}>
                <input
                  type="checkbox"
                  checked={workspace.bindings.some((b) => b.inbound === index && b.set === set.id)}
                  onChange={(e) => {
                    if (e.target.checked) onConnect(set.id, index);
                    else onDisconnect(set.id, index);
                  }}
                />
                {scalarText(inbound.tag || `Inbound ${index + 1}`)}
              </label>
            ),
        )}
      </div>
      <div className="user-summary-list">
        {set.users.slice(0, 100).map((user) => (
          <div key={user.id}>
            <strong>{user.name}</strong>
            <span>
              {user.enabled
                ? scalarText(user.account.email || user.account.user || 'Enabled')
                : 'Disabled'}
            </span>
          </div>
        ))}
        {set.users.length > 100 && (
          <p className="muted">Use Edit users to browse all {set.users.length} users.</p>
        )}
      </div>
      <button className="secondary-button path-read" onClick={onRemove}>
        Remove from graph
      </button>
    </div>
  );
}
